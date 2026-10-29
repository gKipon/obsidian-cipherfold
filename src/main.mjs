import {assertDedicatedVault,setupModal} from './onboarding.mjs';
import {installPassword} from './password-runtime.mjs';
import {Plugin,Modal,Notice,TFile,WorkspaceLeaf,requestUrl} from 'obsidian';
import {ResourceCache,embeddedTargets} from './resource-cache.mjs';
import {VirtualStore,PHYSICAL_ROOT,VIRTUAL_ROOT} from './virtual-store.mjs';
import {bytesToBase64,parseHeaderJSON,parseEnvelopeJSON} from './crypto.mjs';
import {installNoteWorkflow,publishNative} from './note-workflow.mjs';
import {installEditorRevisions} from './editor-revisions.mjs';
import {installReplica} from './replica-runtime.mjs';
import {codecFactory} from './replica-codec.mjs';
import {isEncryptedSecretSlot} from './secret-storage-guard.mjs';
import {installSessionLock} from './session-lock.mjs';

const native = p => typeof p==='string' && (p===VIRTUAL_ROOT || p.startsWith(VIRTUAL_ROOT+'/'));
const physical = p => typeof p==='string' && (p===PHYSICAL_ROOT || p.startsWith(PHYSICAL_ROOT+'/'));
const message = 'Cipherfold: operation blocked. The session is locked, changed or the operation is unsupported.';
const denied = () => { throw Error(message); };
const methods=['exists','stat','list','read','readBinary','write','writeBinary','append','appendBinary','process','mkdir','remove','rename','copy','rmdir','trashSystem','trashLocal','getResourcePath'];

class UnlockModal extends Modal {
  constructor(plugin){super(plugin.app);this.plugin=plugin;}
  onOpen(){
    this.contentEl.createEl('h2',{text:'Unlock encrypted notes'});
    this.contentEl.createEl('p',{text:'Use the native editor, search and links. Your password unlocks notes in application memory.',cls:'cipherfold-native-info'});
    const input=this.contentEl.createEl('input',{type:'password',cls:'cipherfold-native-password'});
    input.autocomplete='off'; input.placeholder='Vault password';
    const error=this.contentEl.createEl('p');
    const progress=this.contentEl.createEl('progress',{cls:'cipherfold-native-progress'});progress.max=100;progress.value=0;progress.hidden=true;
    const status=this.contentEl.createEl('p',{cls:'cipherfold-native-info',attr:{'aria-live':'polite'}});
    const button=this.contentEl.createEl('button',{text:'Unlock',cls:'mod-cta'});
    const submit=async()=>{
      if(button.disabled)return;
      button.disabled=true;input.disabled=true;error.textContent='';progress.hidden=false;
      const password=input.value;input.value='';const started=performance.now();let label='Checking password';
      const render=()=>{status.textContent=label+' · '+((performance.now()-started)/1000).toFixed(1)+' s';};
      this.progressTimer=setInterval(render,100);render();
      const onProgress=p=>{
        const labels={key:'Checking password',catalog:'Opening encrypted catalog',records:`Checking files: ${p.done} of ${p.total}`,cache:'Saving encrypted catalog',publish:'Preparing notes and search',open:'Opening note'};
        label=labels[p.stage]||'Opening';
        progress.value=p.stage==='records'?8+80*(p.total?p.done/p.total:1):({key:0,catalog:5,cache:90,publish:95,open:99}[p.stage]||0);render();
      };
      try{await this.plugin.unlock(password,{onProgress});this.close();}catch{error.textContent=message;button.disabled=false;input.disabled=false;}
      finally{clearInterval(this.progressTimer);}
    };
    button.onclick=submit; input.onkeydown=e=>{if(e.key==='Enter')void submit();};input.focus();
  }
  onClose(){clearInterval(this.progressTimer);this.plugin.epoch++;this.contentEl.empty();}
}

export default class CipherfoldPlugin extends Plugin {
  onload(){
    this.disposed=false;
    this.app.workspace.onLayoutReady(()=>{if(!this.disposed)void this.start().catch(()=>new Notice('Cipherfold: startup failed. Check that this is a dedicated vault and restart Obsidian.'));});
  }
  async start(){
    if(this.app[Symbol.for('cipherfold:guard-owner')])throw Error('RESTART_REQUIRED');
    this.disposed=false;this.ready=false;this.acceptWrites=false;this.lockPromise=null;this.voiceLifecycleVersion=1;
    this.queue=Promise.resolve();this.resources=new ResourceCache(async path=>{const f=this.store.stat(path);if(!f?.binary)denied();const bytes=new Uint8Array(await this.store.readBinary(path));try{return {url:`data:${f.mime};base64,${bytesToBase64(bytes)}`,bytes:bytes.byteLength};}finally{bytes.fill(0);}});this.projected=new Map();this.volatileFolders=new Set();
    this.sessionLocal=new Map();this.sessionConfig=new Map();this.refreshTimer=null;this.epoch=0;
    const {vault,metadataCache:cache}=this.app;
    if(typeof vault.onChange!=='function'||!cache.workQueue||!('transactionSave' in cache)){
      new Notice('Cipherfold: unsupported Obsidian version. Vault remains closed.');return;
    }
    this.adapter=vault.adapter;this.raw={};
    for(const name of methods) if(typeof this.adapter[name]==='function')this.raw[name]=this.adapter[name].bind(this.adapter);
    await assertDedicatedVault(this.raw,vault.configDir);
    // The catalog is encrypted with the vault key and deliberately stays outside
    // the LiveSync namespace. It is disposable; no password/key is persisted.
    const catalogPath=vault.configDir+'/plugins/cipherfold/attachment-catalog.rvcat';
    const passwordManager=installPassword(this,{Modal,Notice,requestUrl,codecFactory});
    this.store=new VirtualStore(this.raw,{isolateConflicts:true,unlockKey:(header,password)=>passwordManager.unlock(header,password),catalog:{
      read:async()=>await this.raw.exists(catalogPath)?this.raw.read(catalogPath):null,
      write:text=>this.raw.write(catalogPath,text),
    }});
    // Empty isolated vault: disable all metadata persistence before virtual discovery.
    if(cache.preloadPromise) await cache.preloadPromise;
    cache.transactionSave=null;
    await cache.clear();
    this.app[Symbol.for('cipherfold:guard-owner')]=this;
    this.installGuards();
    installNoteWorkflow(this,Notice);
    installEditorRevisions(this);
    await installReplica(this,{Modal,Notice,requestUrl,codecFactory});
    const openFile=WorkspaceLeaf.prototype.openFile,p=this;
    WorkspaceLeaf.prototype.openFile=async function(file,...args){
      if(native(file?.path)){
        if(!p.store.isUnlocked||p.lockPromise||p.disposed)denied();
        const other=p.editorViews(file.path).find(view=>view!==this.view);
        if(other){new Notice('Cipherfold: this note is already open in another editor tab.');denied();}
        const stat=p.store.stat(file.path);
        if(stat?.binary)await p.resources.ensure(file.path);
        else await p.prepareResources(await p.store.read(file.path),file.path);
        if(!p.store.isUnlocked||p.lockPromise||p.disposed)denied();
      }
      const result=await openFile.call(this,file,...args);
      if(native(file?.path)&&p.store.isUnlocked)p.captureEditor(this.view,file);
      return result;
    };
    const recovery=this.app.internalPlugins.plugins['file-recovery'];
    if(recovery?.enabled){
      if(typeof recovery.disable!=='function')throw Error('Unsupported File Recovery lifecycle');
      await recovery.disable(false);
    }
    if(recovery) recovery.enable=async()=>{new Notice('Cipherfold: File Recovery is disabled because it persists plaintext copies.');return false;};
    this.addCommand({id:'create',name:'Create encrypted vault',callback:()=>setupModal(this,{Modal,Notice}).open()});
    this.addCommand({id:'unlock',name:'Unlock encrypted notes',callback:()=>void this.openVault()});
    this.addCommand({id:'lock',name:'Lock encrypted notes',callback:()=>void this.lock()});
    this.addCommand({id:'refresh',name:'Refresh encrypted notes',callback:()=>void this.refresh().catch(()=>new Notice(message))});
    this.addRibbonIcon('lock-keyhole','Cipherfold: unlock / lock',()=>this.store.isUnlocked?void this.lock():void this.openVault());
    this.status=this.addStatusBarItem();this.updateStatus();
    const changed=file=>{
      if(!physical(file?.path)||!this.store.isUnlocked)return;
      this.store.invalidate(file.path);clearTimeout(this.refreshTimer);
      this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;void this.refresh().catch(()=>new Notice(message));},500);
    };
    for(const event of ['create','modify','delete'])this.registerEvent(vault.on(event,changed));
    this.sessionLock=await installSessionLock(this,{Modal,Notice});
    this.ready=true;
    this.app.workspace.onLayoutReady(()=>new Notice('Cipherfold: use the lock icon or command palette to unlock notes.'));
  }
  async openVault(){
    if(!this.ready||this.disposed)return;
    if(await this.raw.exists(PHYSICAL_ROOT+'/vault.rvkey'))new UnlockModal(this).open();
    else setupModal(this,{Modal,Notice}).open();
  }
  async createVault(password){
    if(!this.ready||this.disposed||this.lockPromise)denied();
    if([...password].length<12||password.length>1024)denied();
    await this.run(async()=>{
      if(await assertDedicatedVault(this.raw,this.app.vault.configDir))denied();
      await this.store.initialize(password);
      if(this.disposed){this.store.lock();denied();}
      this.acceptWrites=true;await this.publish();this.updateStatus();this.sessionLock.idle.start();
    });
  }
  run(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  updateStatus(){if(this.status)this.status.setText(this.store?.isUnlocked?'Cipherfold · unlocked':'Cipherfold · locked');}
  validateSync(){
    const plugin=this.app.plugins.plugins['obsidian-livesync'];
    if(plugin&&this.replica?.mode==='selective')denied();
    const s=plugin?.core?.settings;
    if(plugin && (!s || s.syncOnlyRegEx!=='^CipherfoldStore/' || s.syncIgnoreRegEx!=='^Native/' || s.syncInternalFiles || s.usePluginSync || s.usePluginSyncV2))denied();
    if(plugin)this.installSyncBoundary(plugin.core);
  }
  installSyncBoundary(core){
    if(this.guardedCore===core)return;
    const access=core.storageAccess,adapter=access?.vaultAccess?.adapter,service=access?.vault;
    if(!adapter?.storage||!adapter?.vault||typeof service?.isTargetFile!=='function')denied();
    // Independent from user-editable regex settings: LiveSync sees raw storage only.
    for(const name of ['isTargetFile','isTargetFileInExtra'])if(typeof service[name]==='function'){
      const original=service[name].bind(service);
      service[name]=(...args)=>physical(typeof args[0]==='string'?args[0]:args[0]?.path)?original(...args):Promise.resolve(false);
    }
    for(const part of ['storage','vault'])for(const name of ['read','readBinary','cachedRead','write','writeBinary','modify','modifyBinary','append','create','createBinary']){
      if(typeof adapter[part][name]!=='function')continue;
      const original=adapter[part][name].bind(adapter[part]);
      adapter[part][name]=(...args)=>{if(!physical(typeof args[0]==='string'?args[0]:args[0]?.path))denied();return original(...args);};
    }
    if(typeof adapter.getFiles==='function'){
      const original=adapter.getFiles.bind(adapter);
      adapter.getFiles=(...args)=>{const files=original(...args);return Array.isArray(files)?files.filter(f=>physical(f.path)):files.then(items=>items.filter(f=>physical(f.path)));};
    }
    this.guardedCore=core;
  }
  installGuards(){
    const a=this.adapter,r=this.raw,p=this;
    const config = path => typeof path==='string' && path.startsWith(p.app.vault.configDir+'/') && !path.split('/').some(x=>!x||x==='.'||x==='..') && !path.includes('\\');
    const durableConfig = path => path===p.app.vault.configDir+'/plugins/obsidian-livesync/data.json';
    this.originalLoadLocal=this.app.loadLocalStorage.bind(this.app);
    this.originalSaveLocal=this.app.saveLocalStorage.bind(this.app);
    this.app.saveLocalStorage=(key,value)=>{
      if(isEncryptedSecretSlot(p.app,key,value))return p.originalSaveLocal(key,value);
      if(key==='secrets-encrypted')throw Error('OS-encrypted secret storage is required');
      if(value)p.sessionLocal.set(key,structuredClone(value));else p.sessionLocal.delete(key);
    };
    this.app.loadLocalStorage=key=>{
      if(key==='secrets-encrypted'){
        const value=p.originalLoadLocal(key);
        return isEncryptedSecretSlot(p.app,key,value)?value:null;
      }
      return p.sessionLocal.has(key)?structuredClone(p.sessionLocal.get(key)):null;
    };
    const checkWrite=(path,data)=>{
      if(!physical(path)||typeof data!=='string')denied();
      if(path===PHYSICAL_ROOT+'/vault.rvkey')parseHeaderJSON(data);
      else if(/^CipherfoldStore\/[0-9a-f-]{36}_[0-9a-f-]{36}\.renc$/.test(path))parseEnvelopeJSON(data);
      else denied();
      return true;
    };
    a.exists=async path=>native(path)?p.store.isUnlocked&&p.store.exists(path):p.sessionConfig.has(path)||r.exists(path);
    a.stat=async path=>native(path)?p.store.isUnlocked?p.store.stat(path):null:p.sessionConfig.has(path)?{type:'file',ctime:p.sessionConfig.get(path).mtime,mtime:p.sessionConfig.get(path).mtime,size:p.sessionConfig.get(path).data.byteLength}:r.stat(path);
    a.list=async path=>{
      if(native(path))return p.store.isUnlocked?p.store.list(path):{files:[],folders:[]};
      const result=await r.list(path);
      if((path===''||path==='/')&&p.store.isUnlocked)return {...result,folders:[...new Set([...result.folders,VIRTUAL_ROOT])]};
      return result;
    };
    a.read=async path=>{
      if(native(path)){const body=await p.store.read(path);await p.prepareResources(body,path);return body;}
      return p.sessionConfig.has(path)?new TextDecoder().decode(p.sessionConfig.get(path).data):r.read(path);
    };
    a.readBinary=async path=>{
      if(!native(path))return p.sessionConfig.has(path)?p.sessionConfig.get(path).data.slice().buffer:r.readBinary(path);
      // Native metadata workers request Markdown through the binary adapter too.
      if(/\.md$/i.test(path))return new TextEncoder().encode(await p.store.read(path)).buffer;
      return p.store.readBinary(path);
    };
    a.getResourcePath=path=>native(path)?p.store.isUnlocked?p.resources.get(path)||'data:,':'data:,':r.getResourcePath(path);
    const write=async(path,data,options={},binary=false)=>{
      if(!native(path)){
        if(config(path)){
          if(durableConfig(path)){
            if(binary)denied();
            // Only LiveSync's connection settings persist. Never native properties/layout.
            return r.write(path,data,options);
          }
          const bytes=binary?new Uint8Array(data).slice():new TextEncoder().encode(data);
          p.sessionConfig.set(path,{data:bytes,mtime:Date.now()});options.immediate?.();return;
        }
        // LiveSync treats .renc/.rvkey as binary. Validate the exact same envelope
        // before allowing its bytes onto disk; arbitrary binary data stays denied.
        if(binary){
          const text=new TextDecoder('utf-8',{fatal:true}).decode(data);
          if(checkWrite(path,text))return r.writeBinary(path,data,options);
        }else if(checkWrite(path,data))return r.write(path,data,options);
        denied();
      }
      if(!p.acceptWrites||p.disposed||!p.store.isUnlocked)denied();p.validateSync();
      return p.run(async()=>{
        if(!p.acceptWrites||p.disposed||!p.store.isUnlocked)denied();
        if(binary)await p.store.writeBinary(path,data);else await p.saveEditorText(path,data);
        options.immediate?.();
        await p.publish();void p.syncReplica({quiet:true});
      }).catch(error=>{new Notice(error.code==='STORE_CONFLICT'
        ? 'Cipherfold: name exists locally or in the archive, or revisions conflict. Original notes retained.' : message);throw error;});
    };
    a.write=(path,data,options)=>write(path,data,options,false);
    a.writeBinary=(path,data,options)=>write(path,data,options,true);
    a.append=async(path,data,options)=>{
      if(!native(path)||typeof data!=='string'||!p.acceptWrites)denied();
      return p.run(async()=>{
        if(!p.acceptWrites||p.disposed)denied();p.validateSync();
        await p.saveEditorText(path,await p.store.read(path)+data);
        options?.immediate?.();await p.publish();void p.syncReplica({quiet:true});
      });
    };
    a.appendBinary=async()=>denied();
    a.process=async(path,fn,options)=>{
      if(!native(path)||!p.acceptWrites)denied();
      // Native process() callbacks are synchronous. Serialize the complete read/transform/write.
      return p.run(async()=>{
        if(!p.acceptWrites||p.disposed)denied();p.validateSync();
        const data=fn(await p.store.read(path));if(typeof data!=='string')denied();
        await p.saveEditorText(path,data);options?.immediate?.();await p.publish();void p.syncReplica({quiet:true});return data;
      });
    };
    a.mkdir=async path=>{
      if(native(path)){
        if(!p.acceptWrites)denied();
        if(path.split('/').some(x=>!x||x==='.'||x==='..')||path.includes('\\'))denied();
        return p.run(async()=>{if(!p.acceptWrites||!p.store.isUnlocked)denied();p.validateSync();await p.store.mkdir(path);await p.publish();void p.syncReplica({quiet:true});});
      }
      if(path===PHYSICAL_ROOT||path.startsWith(p.app.vault.configDir+'/'))return r.mkdir(path);denied();
    };
    for(const name of ['remove','rmdir','trashSystem','trashLocal','rename','copy'])if(r[name])a[name]=async(...args)=>{
      if(args.some(x=>typeof x==='string'&&native(x))){new Notice('Cipherfold: this delete or copy operation is unsupported.');denied();}
      // Physical encrypted history is immutable; keep synced conflict versions.
      if(args.some(x=>typeof x==='string'&&physical(x)))denied();
      denied(); // Config mutations may carry note-derived names too; no raw bypass.
    };
  }
  async unlock(password,{onProgress,fullScan=false}={}){
    const started=performance.now();this.lastUnlockMetrics=null;
    if(!this.ready||this.disposed)denied();if(this.lockPromise)await this.lockPromise;
    this.validateSync();const epoch=++this.epoch;await this.beforeReplicaUnlock(password);
    await this.run(async()=>{
      await this.store.unlock(password,{onProgress,fullScan,replicaEntries:this.replica.entries});
      if(epoch!==this.epoch||this.disposed){this.store.lock();denied();}
      onProgress?.({stage:'publish'});const t=performance.now();
      this.acceptWrites=true;await this.publish();this.updateStatus();
      this.lastUnlockMetrics={...this.store.lastUnlockMetrics,publishMs:performance.now()-t};
    }).catch(error=>{this.closeReplica();throw error;});
    const initialSync=this.syncReplica({quiet:true});
    if(this.replica.mode==='selective'&&!this.store.listFiles().length)await initialSync;
    void initialSync.then(()=>{if(epoch===this.epoch&&this.replica.unlocked)this.watchReplica();});
    if(epoch!==this.epoch||!this.store.isUnlocked)denied();
    this.sessionLock.idle.start();
    const first=this.sessionLock.target();
    onProgress?.({stage:'open'});
    if(first)await this.app.workspace.getLeaf('tab').openFile(this.app.vault.getFileByPath(first.path));
    this.lastUnlockMetrics.totalMs=performance.now()-started;
    for(const warning of this.lastUnlockMetrics.warnings||[])new Notice(warning);
    if(this.status&&!this.replica.unlocked)this.status.setText(`Cipherfold · unlocked in ${(this.lastUnlockMetrics.totalMs/1000).toFixed(1)} s`);
  }
  async prepareResources(body,sourcePath){
    const metadata=this.store.listFiles().filter(f=>f.binary),paths=new Set(metadata.map(f=>f.path));
    const folder=sourcePath.slice(0,sourcePath.lastIndexOf('/'));
    const normal=value=>{const out=[];for(const part of value.split('/')){if(part==='..')out.pop();else if(part&&part!=='.')out.push(part);}return out.join('/');};
    for(const link of embeddedTargets(body)){
      const candidates=[link,VIRTUAL_ROOT+'/'+link,normal(folder+'/'+link)];
      let target=candidates.find(p=>paths.has(p));
      if(!target){const matches=metadata.filter(f=>f.path.endsWith('/'+link));if(matches.length===1)target=matches[0].path;}
      if(target)await this.resources.ensure(target);
    }
  }
  async publish(){await publishNative(this);}
  async refresh(){
    if(!this.store.isUnlocked||this.disposed||this.lockPromise)return;
    return this.run(async()=>{
      if(!this.store.isUnlocked||this.disposed)return;
      this.validateSync();await this.store.refresh();await this.publish();
    }).catch(async error=>{await this.lock();throw error;});
  }
  async lock(){
    this.epoch++;
    try{this.app.workspace.trigger?.('cipherfold:will-lock');}catch{}
    if(this.lockPromise)return this.lockPromise;
    this.sessionLock?.idle.stop();
    this.lockPromise=this.performLock().finally(()=>{this.lockPromise=null;});
    return this.lockPromise;
  }
  async settleView(view){
    // TextFileView.save() returns early while another save is active. Its internal
    // follow-up is not the promise returned to us, so observe the native state too.
    const deadline=Date.now()+10000;
    while(view.saving){
      if(Date.now()>deadline)denied();
      await this.queue;await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  async performLock(){
    clearTimeout(this.refreshTimer);
    const ws=this.app.workspace,cache=this.app.metadataCache;
    // Obsidian stops traversal on a truthy callback result. Array.push returns a
    // positive length, so collection callbacks must explicitly return nothing.
    const leaves=[];ws.iterateAllLeaves(leaf=>{leaves.push(leaf);});
    const views=leaves.filter(leaf=>native(leaf.view?.file?.path)).map(leaf=>leaf.view);
    const inert=views.map(view=>[view.containerEl,view.containerEl?.inert]);
    for(const [el] of inert)if(el)el.inert=true; // Freeze native editor and property inputs while draining.
    try{
      for(const view of views)if(typeof view.save==='function'){
        await this.settleView(view);await view.save();await this.settleView(view);
      }
      await this.queue;
      // A swallowed native follow-up error or two divergent views must cancel lock.
      const checked=[];
      for(const view of views)if(typeof view.getViewData==='function'){
        const data=view.getViewData();
        if(typeof data!=='string'||!await this.verifyEditorSaved(view))denied();
        checked.push([view,data]);
      }
      await this.queue;
      for(const [view,data] of checked)if(view.saving||view.getViewData()!==data)denied();
      const current=[];ws.iterateAllLeaves(leaf=>{if(native(leaf.view?.file?.path))current.push(leaf.view);});
      // Obsidian recreates read-only outline/link panes during a save. Only a
      // newly appeared editable view can contain a draft we did not drain.
      if(current.some(view=>!views.includes(view)&&(typeof view.save==='function'||typeof view.getViewData==='function'||view.getViewType?.()==='file-properties')))denied();
      this.acceptWrites=false;
    }catch{
      for(const [el,value] of inert)if(el)el.inert=value;
      this.sessionLock?.idle.start();
      new Notice('Cipherfold: save failed. Session remains unlocked; retry saving before closing.');return false;
    }
    try{await this.sessionLock?.rememberCurrent();}
    catch{new Notice('Cipherfold: unable to remember the last open note.');}
    const closingLeaves=[];ws.iterateAllLeaves(leaf=>{closingLeaves.push(leaf);});
    for(const leaf of closingLeaves){
      const type=leaf.view?.getViewType?.();
      if(native(leaf.view?.file?.path)||['search','backlink','outgoing-link','graph','localgraph','tag','all-properties','file-properties'].includes(type))leaf.detach();
    }
    await cache.workQueue.promise;
    const virtual=this.app.vault.getAllLoadedFiles().filter(f=>native(f.path)).sort((a,b)=>b.path.length-a.path.length);
    for(const f of virtual){f.cache?.(null);this.app.vault.onChange(f instanceof TFile?'file-removed':'folder-removed',f.path);}
    cache.cleanupDeletedCache();cache.blockCache?.clear();
    const types=this.app.metadataTypeManager;
    if(types){types.assignedWidgets={};types.rebuildProperties();}
    ws.recentFileTracker.lastOpenFiles=[];
    this.projected.clear();this.resources.clear();this.volatileFolders.clear();this.sessionLocal.clear();this.sessionConfig.clear();
    this.closeReplica();this.editorBaselines=new WeakMap();this.store.lock();this.updateStatus();return true;
  }
  onunload(){
    if(!this.store){this.disposed=true;return;}
    // Guard hooks deliberately remain until application reload: restoring raw writes
    // while native views have pending saves could put plaintext onto disk.
    this.epoch++;clearTimeout(this.refreshTimer);
    this.sessionLock?.idle.stop();
    void this.lock().then(locked=>{
      if(locked){this.disposed=true;this.acceptWrites=false;this.store.lock();}
      else new Notice('Cipherfold: unload encountered a save failure. Session kept in memory; do not restart until saved.');
    });
  }
}
