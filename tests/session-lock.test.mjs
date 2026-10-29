import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IdleLock,sessionSettings,installSessionLock} from '../src/session-lock.mjs';
function clock(){
 let wall=0,mono=0,expired=0;const timers=new Map();let next=0;
 const idle=new IdleLock({now:()=>wall,monotonic:()=>mono,onExpire:()=>expired++,schedule:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},cancel:id=>timers.delete(id)});
 return {idle,timers,get expired(){return expired;},advance(ms){wall+=ms;mono+=ms;},sleep(ms){wall+=ms;},adjust(ms){wall+=ms;}};
}
test('unload while reading preferences creates no late timers or listeners',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const plugin={app:{vault:{configDir:'.test-config'}},raw:{exists:()=>gate},registerDomEvent(){assert.fail('late listener');},register(){assert.fail('late cleanup');}};
 const pending=installSessionLock(plugin,{Modal:class{},Notice:class{}});plugin.unloading=true;release(false);
 assert.equal(await pending,null);
});
test('default locks once after five minutes, activity extends it, stop cancels it',()=>{
 const c=clock();c.idle.start();c.advance(299000);assert.equal(c.idle.check(),false);
 c.idle.activity();c.advance(299000);assert.equal(c.idle.check(),false);c.advance(1000);
 assert.equal(c.idle.check(),true);assert.equal(c.expired,1);assert.equal(c.timers.size,0);c.idle.check();assert.equal(c.expired,1);
 c.idle.start();c.idle.stop();c.advance(300000);assert.equal(c.idle.check(),false);
});
test('sleep and suspended background timers expire before resume input can extend them',()=>{
 const c=clock();c.idle.start();c.sleep(300001);c.idle.activity();assert.equal(c.expired,1);assert.equal(c.idle.active,false);
});
test('clock rollback cannot extend a session and shortening timeout checks original last activity',()=>{
 const c=clock();c.idle.start();c.advance(120000);c.adjust(-3600000);c.idle.setMinutes(1);assert.equal(c.expired,1);
 assert.throws(()=>c.idle.setMinutes(0));assert.throws(()=>c.idle.setMinutes(1.5));assert.throws(()=>c.idle.setMinutes(1441));
});
test('increasing interval rearms against original activity rather than granting a new interval',()=>{
 const c=clock();c.idle.start();c.advance(240000);c.idle.setMinutes(6);c.advance(120000);assert(c.idle.check());
});
test('preferences reject paths, extra payloads, invalid IDs and unbounded intervals',()=>{
 assert.deepEqual(sessionSettings({version:1,autoLockMinutes:5,lastObjectId:null}),{version:1,autoLockMinutes:5,lastObjectId:null});
 for(const value of [{version:1,autoLockMinutes:0,lastObjectId:null},{version:1,autoLockMinutes:5,lastObjectId:'Native/secret.md'},{version:1,autoLockMinutes:5,lastObjectId:null,text:'secret'}])assert.throws(()=>sessionSettings(value));
});
test('visibility/focus do not lock early or reset deadline; only trusted foreground activity extends it',async()=>{
 const handlers=new Map(),cleanup=[];let locked=0;
 globalThis.document={hidden:false,hasFocus:()=>true};globalThis.window={};
 const p={raw:{exists:async()=>false},app:{vault:{configDir:'.obsidian'},workspace:{},plugins:{plugins:{}}},store:{isUnlocked:true},
   lock:async()=>{locked++;return true;},registerDomEvent:(target,name,fn)=>handlers.set(name,fn),registerEvent(){},register:fn=>cleanup.push(fn),addCommand(){}};
 try{
  const s=await installSessionLock(p,{Modal:class{},Notice:class{}}),c=clock();
  s.idle.now=c.idle.now;s.idle.monotonic=c.idle.monotonic;s.idle.schedule=c.idle.schedule;s.idle.cancel=c.idle.cancel;
  s.idle.start();c.advance(120000);document.hidden=true;handlers.get('visibilitychange')();assert.equal(locked,0);
  handlers.get('pointermove')({isTrusted:true});document.hidden=false;handlers.get('focus')();handlers.get('keydown')({isTrusted:false});
  c.advance(180000);handlers.get('pageshow')();assert.equal(locked,1);
  s.idle.start();c.advance(240000);handlers.get('keydown')({isTrusted:true});c.advance(240000);handlers.get('focus')();assert.equal(locked,1);
 }finally{cleanup.forEach(f=>f());delete globalThis.window;delete globalThis.document;}
});
