import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVault,encryptRecord,decryptRecord,encryptReplicaMessage,decryptReplicaMessage,encryptCatalog,decryptCatalog,unlockPasswordKey,makePasswordCredential,verifyPasswordCredential,parsePasswordCredential} from '../src/crypto.mjs';
import {PasswordManager,passwordIO} from '../src/password-manager.mjs';
const old='synthetic-old-password',next='synthetic-new-password',third='synthetic-third-password';
async function fixture(){
 const {header,key}=await createVault(old),config=await encryptReplicaMessage(header,key,'config',{version:1,mode:'selective',connection:{}});
 let remote=null,revision=0;const transport={connect:async()=>{},getDoc:async()=>structuredClone(remote),comparePassword:async(id,previous,credential)=>{assert.equal(previous?._rev,remote?._rev);remote={_id:id,_rev:String(++revision),type:'rv-password',payload:JSON.stringify(credential)};return structuredClone(remote);}};
 const client=()=>{let local=null;const io={read:async()=>local,write:async v=>{local=structuredClone(v);}};const manager=new PasswordManager({io,readHeader:async()=>JSON.stringify(header),readConfig:async()=>config,transportFactory:()=>transport});return {io,manager};};
 return {header,key,client,transport,getRemote:()=>remote,setRemote:v=>{remote=v;}};
}
test('rewrap keeps existing record, catalogue, configuration readable and rejects old password',async()=>{
 const {header,key}=await createVault(old),at='2026-10-26T00:00:00.000Z';
 const record={objectId:crypto.randomUUID(),revisionId:crypto.randomUUID(),parents:[],kind:'note',name:'Native/test.md',mime:'text/markdown',createdAt:at,updatedAt:at,body:'synthetic body'};
 const encrypted=await encryptRecord(header,key,record),config=await encryptReplicaMessage(header,key,'config',{test:true}),catalog=await encryptCatalog(header,key,[]),before=JSON.stringify(encrypted);
 const slot=await makePasswordCredential(header,null,old,next),newKey=await unlockPasswordKey(header,next,slot);
 assert.deepEqual(await decryptRecord(header,newKey,encrypted),record);assert.equal(JSON.stringify(encrypted),before);assert.deepEqual(await decryptReplicaMessage(header,newKey,'config',config),{test:true});assert.deepEqual(await decryptCatalog(header,newKey,catalog),[]);
 await assert.rejects(unlockPasswordKey(header,old,slot));await unlockPasswordKey(header,old); // Explicit retained recovery limitation.
 const second=await makePasswordCredential(header,slot,next,third);assert.equal(second.generation,2);await unlockPasswordKey(header,third,second);await assert.rejects(unlockPasswordKey(header,next,second));
});
test('credential rejects cross-vault substitution, tampering, too short and same passwords',async()=>{
 const a=await createVault(old),b=await createVault(old),c=await makePasswordCredential(a.header,null,old,next);
 await assert.rejects(unlockPasswordKey(b.header,next,c));await assert.rejects(verifyPasswordCredential(a.header,a.key,{...c,generation:2}));await assert.rejects(verifyPasswordCredential(a.header,a.key,{...c,wrapped:b.header}));
 await assert.rejects(makePasswordCredential(a.header,null,old,'123'));await assert.rejects(makePasswordCredential(a.header,null,old,old));await assert.rejects(makePasswordCredential(a.header,null,'wrong-long-password',next));
 assert.throws(()=>parsePasswordCredential(JSON.stringify(c).replace('"generation":1','"generation":1,"generation":1')));
});
test('four-digit PIN preserves leading zero, existing content and rotation back to a long password',async()=>{
 const f=await fixture(),a=f.client(),b=f.client(),pin='0427';
 const encrypted=await encryptReplicaMessage(f.header,f.key,'config',{synthetic:true});
 await a.manager.change(old,pin);const key=await a.manager.unlock(f.header,pin);
 assert.deepEqual(await decryptReplicaMessage(f.header,key,'config',encrypted),{synthetic:true});
 await assert.rejects(a.manager.unlock(f.header,'427'));await assert.rejects(a.manager.unlock(f.header,'0428'));
 await b.manager.sync(f.header,f.key,f.transport);await b.manager.unlock(f.header,pin);
 await b.manager.change(pin,next);await a.manager.sync(f.header,key,f.transport);
 await a.manager.unlock(f.header,next);await assert.rejects(a.manager.unlock(f.header,pin));
});
test('four-character passwords work with letters and Unicode without trimming or numeric conversion',async()=>{
 for(const password of ['0aБ!','🔐🔑🌍😀']){
  const {header,key}=await createVault(password),encrypted=await encryptReplicaMessage(header,key,'config',{synthetic:true});
  const unlocked=await unlockPasswordKey(header,password);
  assert.deepEqual(await decryptReplicaMessage(header,unlocked,'config',encrypted),{synthetic:true});
 }
});
test('offline peer adopts password at exchange without changing its live key; stale password cannot rotate again',async()=>{
 const f=await fixture(),a=f.client(),b=f.client();assert.equal(await a.manager.change(old,next),1);
 await b.manager.unlock(f.header,old);await assert.rejects(b.manager.change(old,third),e=>e.code==='PASSWORD_UPDATED_REOPEN');
 await assert.rejects(b.manager.unlock(f.header,old));await b.manager.unlock(f.header,next);assert.equal(await b.manager.change(next,third),2);
 await a.manager.sync(f.header,f.key,f.transport);await a.manager.unlock(f.header,third);
 const remote=f.getRemote();f.setRemote(null);await assert.rejects(a.manager.sync(f.header,f.key,f.transport),e=>e.code==='PASSWORD_REMOTE_MISSING');f.setRemote(remote);
});
test('lost ACK and failed local commit recover by authenticated exchange without second password mutation',async()=>{
 const f=await fixture(),a=f.client(),compare=f.transport.comparePassword;
 f.transport.comparePassword=async(...args)=>{await compare(...args);throw Error('connection lost');};
 await assert.rejects(a.manager.change(old,next));assert.equal(await a.io.read(),null);
 await a.manager.sync(f.header,f.key,f.transport);await a.manager.unlock(f.header,next);
 const b=f.client(),write=b.io.write;b.io.write=async()=>{throw Error('disk full');};await assert.rejects(b.manager.sync(f.header,f.key,f.transport));b.io.write=write;await b.manager.sync(f.header,f.key,f.transport);await b.manager.unlock(f.header,next);
});
test('password journal publishes only complete files and rejects conflicting generations',async()=>{
 const files=new Map(),root='plugin';const raw={list:async()=>({files:[...files.keys()]}),exists:async p=>p===root||files.has(p),read:async p=>files.get(p),write:async(p,v)=>files.set(p,v),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);}};
 const io=passwordIO(raw,root),{header}=await createVault(old),c=await makePasswordCredential(header,null,old,next);
 await io.write(c);assert.deepEqual(await io.read(),c);await io.write(c);files.set(root+'/password-key-incomplete.tmp','torn');assert.deepEqual(await io.read(),c);
 const other=await makePasswordCredential(header,null,old,third);await io.write(other);await assert.rejects(io.read(),e=>e.code==='PASSWORD_LOCAL_CONFLICT');
});

test('local-only password rotation verifies read-back, preserves data and never contacts a server',async()=>{
 const {header,key}=await createVault(old),encrypted=await encryptReplicaMessage(header,key,'config',{synthetic:true});let saved=null;
 const manager=new PasswordManager({io:{read:async()=>saved,write:async v=>{saved=structuredClone(v);}},readHeader:async()=>JSON.stringify(header),readConfig:async()=>null,transportFactory:()=>{assert.fail('local vault attempted network');}});
 assert.equal(await manager.change(old,next),1);
 assert.deepEqual(await decryptReplicaMessage(header,await manager.unlock(header,next),'config',encrypted),{synthetic:true});
 await assert.rejects(manager.unlock(header,old));assert.equal(await manager.change(next,third),2);
 await manager.unlock(header,third);await unlockPasswordKey(header,old); // Retained header remains a recovery copy.
});
test('unreadable or corrupt enrollment never falls back to local password rotation',async()=>{
 const {header}=await createVault(old);let writes=0;
 for(const readConfig of [async()=>{throw Error('read failed');},async()=>'',async()=>'invalid']){
  const manager=new PasswordManager({io:{read:async()=>null,write:async()=>{writes++;}},readHeader:async()=>JSON.stringify(header),readConfig,transportFactory:()=>{assert.fail('invalid enrollment contacted server');}});
  await assert.rejects(manager.change(old,next));
 }
 assert.equal(writes,0);
});
test('failed local password commit cannot report success',async()=>{
 const {header}=await createVault(old);
 const manager=new PasswordManager({io:{read:async()=>null,write:async()=>{}},readHeader:async()=>JSON.stringify(header),readConfig:async()=>null});
 await assert.rejects(manager.change(old,next));await manager.unlock(header,old);
});
