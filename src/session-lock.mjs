// Device-local preferences contain no title, path, text, password or key.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const DEFAULT_MINUTES=5;
export function validMinutes(value){return Number.isInteger(value)&&value>=1&&value<=1440;}
export function sessionSettings(value){
  if(!value||value.version!==1||!validMinutes(value.autoLockMinutes)||
    !(value.lastObjectId===null||typeof value.lastObjectId==='string'&&UUID.test(value.lastObjectId))||
    Object.keys(value).some(k=>!['version','autoLockMinutes','lastObjectId'].includes(k)))throw Error('Invalid session preferences');
  return {version:1,autoLockMinutes:value.autoLockMinutes,lastObjectId:value.lastObjectId};
}

// A wall clock catches suspended mobile timers; monotonic time also prevents a
// backwards system-clock adjustment from extending an awake session.
export class IdleLock {
  constructor({onExpire,now=()=>Date.now(),monotonic=()=>performance.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),minutes=DEFAULT_MINUTES}){
    this.onExpire=onExpire;this.now=now;this.monotonic=monotonic;this.schedule=schedule;this.cancel=cancel;this.minutes=minutes;this.active=false;
  }
  start(){this.stop();this.active=true;this.reset();}
  stop(){this.active=false;this.cancel(this.timer);this.timer=null;}
  reset(){this.wall=this.now();this.mono=this.monotonic();this.arm();}
  elapsed(){return Math.max(0,this.now()-this.wall,this.monotonic()-this.mono);}
  arm(){this.cancel(this.timer);if(this.active){this.timer=this.schedule(()=>this.check(),Math.max(1,this.minutes*60000-this.elapsed()));this.timer?.unref?.();}}
  check(){
    if(!this.active)return false;
    if(this.elapsed()<this.minutes*60000){this.arm();return false;}
    this.stop();this.onExpire();return true;
  }
  activity(){if(this.active&&!this.check())this.reset();}
  setMinutes(minutes){if(!validMinutes(minutes))throw Error('Invalid idle timeout');this.minutes=minutes;if(this.active)this.check();}
}

export async function installSessionLock(plugin,{Modal,Notice}){
  const path=plugin.app.vault.configDir+'/plugins/cipherfold/session-state.json';
  let settings={version:1,autoLockMinutes:DEFAULT_MINUTES,lastObjectId:null};
  try{if(await plugin.raw.exists(path))settings=sessionSettings(JSON.parse(await plugin.raw.read(path)));}
  catch{new Notice('Cipherfold: lock settings unavailable. Using five minutes.');}
  let writes=Promise.resolve(),disposed=false;
  const persist=()=>{
    const text=JSON.stringify(sessionSettings(settings));
    const next=writes.catch(()=>{}).then(()=>plugin.raw.write(path,text));writes=next;return next;
  };
  const remember=async file=>{
    if(!plugin.store.isUnlocked||!file?.path?.startsWith('Native/'))return;
    const id=plugin.store.stat(file.path)?.objectId;
    if(typeof id==='string'&&UUID.test(id)&&id!==settings.lastObjectId){settings.lastObjectId=id;await persist();}
  };
  const idle=new IdleLock({minutes:settings.autoLockMinutes,onExpire:()=>{
    void plugin.lock().then(locked=>{
      // The existing save-failure policy keeps a draft editable. Retry after a
      // fresh interval; never discard it merely to satisfy the timer.
      if(!locked&&!disposed&&!idle.active)idle.start();
    }).catch(()=>{if(!disposed&&plugin.store.isUnlocked)idle.start();});
  }});
  const foreground=()=>!document.hidden&&(!document.hasFocus||document.hasFocus());
  for(const name of ['pointerdown','pointermove','keydown','input','wheel','touchstart','touchmove'])
    plugin.registerDomEvent(document,name,event=>{if(event.isTrusted&&foreground()&&plugin.store.isUnlocked&&!plugin.lockPromise)idle.activity();});
  // Neither hiding nor focusing a window restarts the deadline.
  plugin.registerDomEvent(document,'visibilitychange',()=>idle.check());
  if(typeof window!=='undefined')for(const name of ['focus','pageshow'])plugin.registerDomEvent(window,name,()=>idle.check());
  if(plugin.app.workspace.on)plugin.registerEvent(plugin.app.workspace.on('file-open',file=>{
    void remember(file).catch(()=>new Notice('Cipherfold: unable to remember the open note.'));
  }));
  // Foreground dictation is user activity, including waiting for its result.
  const voiceTimer=setInterval(()=>{
    if(!foreground()||!plugin.store.isUnlocked||plugin.lockPromise)return;
    if(['requesting','recording','stopping','transcribing'].includes(plugin.app.plugins.plugins['dictation-bridge']?.session?.state))idle.activity();
  },1000);
  voiceTimer.unref?.();
  plugin.register(()=>{disposed=true;idle.stop();clearInterval(voiceTimer);});
  const session={
    idle,
    get settings(){return {...settings};},
    async rememberCurrent(){await remember(plugin.app.workspace.getActiveFile?.());await writes;},
    async setMinutes(minutes){
      if(!validMinutes(minutes))throw Error('Invalid idle timeout');
      const previous=settings.autoLockMinutes;settings={...settings,autoLockMinutes:minutes};
      try{await persist();}catch(error){settings.autoLockMinutes=previous;throw error;}
      idle.setMinutes(minutes);
    },
    target(){return plugin.store.listFiles().find(f=>f.objectId===settings.lastObjectId)||plugin.store.listFiles().find(f=>!f.binary);},
  };
  class LockSettings extends Modal {
    onOpen(){
      this.contentEl.createEl('h2',{text:'Automatic lock'});
      this.contentEl.createEl('p',{text:'Lock after inactivity. Hiding or switching windows does not immediately lock notes. This setting applies to this device.'});
      const input=this.contentEl.createEl('input',{type:'number',attr:{min:'1',max:'1440',step:'1','aria-label':'Minutes until lock'}});input.value=String(settings.autoLockMinutes);
      const error=this.contentEl.createEl('p');
      const button=this.contentEl.createEl('button',{text:'Save',cls:'mod-cta'});
      const submit=async()=>{
        if(button.disabled)return;
        const minutes=Number(input.value);
        if(!validMinutes(minutes)){error.textContent='Enter an integer from 1 to 1440 minutes.';return;}
        button.disabled=true;
        try{await session.setMinutes(minutes);new Notice(`Cipherfold: lock after ${minutes} minutes of inactivity.`);this.close();}
        catch{error.textContent='Unable to save setting. Try again.';button.disabled=false;}
      };
      button.onclick=submit;input.onkeydown=e=>{if(e.key==='Enter')void submit();};input.focus();
    }
    onClose(){this.contentEl.empty();}
  }
  plugin.addCommand({id:'auto-lock-settings',name:'Automatic lock: change timeout',callback:()=>new LockSettings(plugin.app).open()});
  return session;
}
