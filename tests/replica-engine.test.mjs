import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVault,encryptRecord,encryptReplicaMessage,decryptReplicaMessage,ciphertextDigest} from '../src/crypto.mjs';
import {descriptor,recordPath} from '../src/replica-model.mjs';
import {ReplicaEngine} from '../src/replica-engine.mjs';
const password='synthetic-selective-password';
const now='2026-10-25T00:00:00.000Z';
async function setup(){
 const {header,key}=await createVault(password),server=new Map(),files=new Map(),uploads=[];
 const record=(name,date,body='hello',extra={})=>({objectId:crypto.randomUUID(),revisionId:crypto.randomUUID(),parents:[],kind:'note',name,mime:'text/markdown',createdAt:date,updatedAt:date,body,...extra});
 const old=record('Native/old.md','2020-01-01T00:00:00.000Z'),recent=record('Native/recent.md',now),media=record('Native/a.png','2020-01-01T00:00:00.000Z','AQID',{kind:'attachment',mime:'image/png'});
 recent.body+=' ![[a.png]]';const records=[old,recent,media],entries=[];
 for(const r of records){const raw=JSON.stringify(await encryptRecord(header,key,r));files.set(recordPath(r),raw);entries.push(descriptor(r,{sha256:await ciphertextDigest(raw),ciphertextBytes:new TextEncoder().encode(raw).length},records));}
 const baseId='rv-catalog:'+crypto.randomUUID();server.set(baseId,{_id:baseId,type:'rv-selective',payload:await encryptReplicaMessage(header,key,baseId,entries)});
 const transport={connect:async()=>{},getDoc:async id=>structuredClone(server.get(id)||null),listCatalog:async()=>[...server.values()].filter(d=>d._id.startsWith('rv-revision:')),appendDoc:async(id,doc)=>{if(!server.has(id))server.set(id,doc);return server.get(id);},readRecord:async e=>{const raw=files.get(recordPath(e));assert(raw);return raw;},writeRecord:async(e,raw)=>{uploads.push(e.revisionId);if(files.has(recordPath(e)))assert.equal(files.get(recordPath(e)),raw);files.set(recordPath(e),raw);}};
 async function client(){
  const local=new Map(),states=new Map();let config=await encryptReplicaMessage(header,key,'config',{version:1,mode:'selective',connection:{},baseId,months:12,maxDownloadBytes:64*1024*1024});
  const io={readHeader:async()=>JSON.stringify(header),readConfig:async()=>config,writeConfig:async x=>{config=x;},readState:async slot=>states.get(slot),writeState:async(slot,x)=>{states.set(slot,x);},hasRecord:async e=>local.has(recordPath(e)),readRecord:async e=>local.get(recordPath(e)),writeRecord:async(e,x)=>{local.set(recordPath(e),x);}};
  let own=[];const provider=async()=>[...entries,...own].filter(e=>local.has(recordPath(e)));
  const make=()=>new ReplicaEngine({io,transportFactory:()=>transport,clock:()=>now});
  const engine=make();await engine.open(password);
  return {engine,make,local,states,io,provider,add:async r=>{const raw=JSON.stringify(await encryptRecord(header,key,r)),entry=descriptor(r,{sha256:await ciphertextDigest(raw),ciphertextBytes:raw.length},[...records,r]);local.set(recordPath(r),raw);own.push(entry);return entry;}};
 }
 return {header,key,server,files,records,entries,transport,uploads,record,client};
}
test('recent selection fetches old media; archive pin persists and does not mirror old payloads',async()=>{
 const f=await setup(),c=await f.client();const plan=await c.engine.sync(c.provider);
 assert.equal(plan.downloads.length,2);assert.equal(c.local.size,2);assert(!c.local.has(recordPath(f.records[0])));
 assert.equal(c.engine.archive().length,2);await c.engine.pin(f.records[0].objectId);await c.engine.sync(c.provider);assert.equal(c.local.size,3);
 c.engine.lock();const reopened=c.make();await reopened.open(password);assert(reopened.archive().find(r=>r.objectId===f.records[0].objectId).pinned);
 for(const text of c.states.values()){assert(!text.includes('recent.md'));assert(!text.includes('hello'));}
});
test('ambiguous send survives restart; immutable ID retries and acknowledgement follows descriptor readback',async()=>{
 const f=await setup(),c=await f.client();await c.engine.sync(c.provider);
 const edited={...f.records[1],revisionId:crypto.randomUUID(),parents:[f.records[1].revisionId],body:'offline edit'};const e=await c.add(edited);
 const write=f.transport.writeRecord;let fail=true;
 f.transport.writeRecord=async(...args)=>{await write(...args);if(fail){fail=false;throw Error('network after acceptance');}};
 await assert.rejects(c.engine.sync(c.provider));assert.equal(c.engine.status.state,'retry');assert.equal(c.engine.status.pending,1);
 c.engine.lock();const recovered=c.make();await recovered.open(password);await recovered.sync(c.provider);
 assert.equal(recovered.status.pending,0);assert(f.server.has('rv-revision:'+e.revisionId));assert.equal(f.uploads.filter(x=>x===e.revisionId).length,2);
});
test('concurrent offline edits preserve both heads and merge revision supersedes both',async()=>{
 const f=await setup(),a=await f.client(),b=await f.client();await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 const base=f.records[1],left={...base,revisionId:crypto.randomUUID(),parents:[base.revisionId],body:'left'},right={...base,revisionId:crypto.randomUUID(),parents:[base.revisionId],body:'right'};
 await a.add(left);await b.add(right);await a.engine.sync(a.provider);await b.engine.sync(b.provider);await a.engine.sync(a.provider);
 assert.equal(a.engine.status.conflicts,1);assert.equal(a.engine.archive().filter(e=>e.objectId===base.objectId).length,2);
 const merged={...base,revisionId:crypto.randomUUID(),parents:[left.revisionId,right.revisionId],body:'left and right'};await a.add(merged);await a.engine.sync(a.provider);
 assert.equal(a.engine.archive().filter(e=>e.objectId===base.objectId).length,1);
});
test('tampered catalogue, context substitution and mismatched record cannot be projected',async()=>{
 const f=await setup(),c=await f.client();const base=[...f.server.values()][0],bad=JSON.parse(base.payload);bad.ciphertext=bad.ciphertext.slice(0,-6)+'AAAAAA';base.payload=JSON.stringify(bad);
 await assert.rejects(c.engine.sync(c.provider));assert.equal(c.local.size,0);
 const encrypted=await encryptReplicaMessage(f.header,f.key,'state',{a:1});await assert.rejects(decryptReplicaMessage(f.header,f.key,'config',encrypted));
});
test('download budget, missing body and torn checkpoint never acknowledge completion',async()=>{
 const f=await setup(),c=await f.client();await c.engine.setWindow(12,0);const plan=await c.engine.sync(c.provider);assert(!plan.withinBudget);assert.equal(c.local.size,0);assert.equal(c.engine.status.state,'budget');
 await c.engine.setWindow(12,1024*1024);const read=f.transport.readRecord;f.transport.readRecord=async()=>{throw Error('missing chunk');};await assert.rejects(c.engine.sync(c.provider));assert.equal(c.engine.status.state,'retry');assert.equal(c.local.size,0);
 f.transport.readRecord=read;await c.engine.sync(c.provider);
 // Damage latest checkpoint, retain prior authenticated state. The outbox is files.
 const slots=[];for(const [slot,raw]of c.states){slots.push([slot,(await decryptReplicaMessage(f.header,f.key,'state',raw)).sequence]);}slots.sort((a,b)=>b[1]-a[1]);c.states.set(slots[0][0],'torn');
 c.engine.lock();const reopened=c.make();await reopened.open(password);await reopened.sync(c.provider);assert.equal(reopened.status.state,'current');
});
test('locking during download discards late response and writes no payload',async()=>{
 const f=await setup(),c=await f.client();const read=f.transport.readRecord;f.transport.readRecord=async e=>{c.engine.lock();return read(e);};await assert.rejects(c.engine.sync(c.provider));assert.equal(c.local.size,0);assert.equal(c.engine.unlocked,false);
});

test('offline save is journaled before connecting and remains pending after restart',async()=>{
 const f=await setup(),c=await f.client();await c.engine.sync(c.provider);const edit={...f.records[1],revisionId:crypto.randomUUID(),parents:[f.records[1].revisionId],body:'saved without network'};await c.add(edit);
 f.transport.connect=async()=>{throw Error('offline');};await assert.rejects(c.engine.sync(c.provider));assert.equal(c.engine.status.pending,1);c.engine.lock();
 const reopened=c.make();await reopened.open(password);assert(reopened.archive().some(e=>e.revisionId===edit.revisionId));assert.equal(reopened.plan(await c.provider()).pendingRevisions.length,1);
 f.transport.connect=async()=>{};await reopened.sync(c.provider);assert.equal(reopened.status.pending,0);
});

test('a second full publisher advertises initial revisions to clients of the older base',async()=>{
 const f=await setup(),publisher=await f.client();for(const [p,raw]of f.files)publisher.local.set(p,raw);
 const added=f.record('Native/second-publisher-old.md','2020-01-01T00:00:00.000Z','unseen by first base');const entry=await publisher.add(added);
 await publisher.io.writeConfig(null);f.transport.readFile=async()=>JSON.stringify(f.header);
 await publisher.engine.bootstrap(password,{},publisher.provider);assert(f.server.has('rv-revision:'+entry.revisionId));
 const reader=await f.client();await reader.engine.sync(reader.provider);assert(reader.engine.archive().some(e=>e.revisionId===entry.revisionId));
 assert.equal(reader.local.has(recordPath(entry)),false);await reader.engine.pin(entry.objectId);await reader.engine.sync(reader.provider);assert(reader.local.has(recordPath(entry)));
});

async function initialPublisher(f){
 const c=await f.client();for(const [p,raw]of f.files)c.local.set(p,raw);
 await c.io.writeConfig(null);c.engine.lock();f.transport.readFile=async()=>JSON.stringify(f.header);return c;
}
test('failed initial publication cannot export enrollment and retries retained immutable revisions',async()=>{
 const f=await setup(),c=await initialPublisher(f),append=f.transport.appendDoc;let count=0;
 f.transport.appendDoc=async(...args)=>{const result=await append(...args);if(++count===2)throw Error('reply lost');return result;};
 await assert.rejects(c.engine.bootstrap(password,{},c.provider));
 assert.equal(c.engine.unlocked,false);assert.equal(await c.io.readConfig(),null);await assert.rejects(c.engine.enrollment());
 const retained=[...f.server.keys()].filter(id=>id.startsWith('rv-revision:'));assert(retained.length>=2&&retained.length<=f.entries.length);
 f.transport.appendDoc=append;await c.engine.bootstrap(password,{},c.provider);assert.equal(c.engine.unlocked,true);
 assert(retained.every(id=>f.server.has(id)));assert.equal(c.engine.status.state,'current');assert(await c.engine.enrollment());
});
test('initial publication is unavailable to sync and export until its verified commit',async()=>{
 const f=await setup(),c=await initialPublisher(f);let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});f.transport.connect=()=>{entered();return new Promise(resolve=>{release=resolve;});};
 const preparing=c.engine.bootstrap(password,{},c.provider);await started;
 assert.equal(c.engine.unlocked,false);assert.throws(()=>c.engine.sync(c.provider));await assert.rejects(c.engine.enrollment());
 await assert.rejects(c.engine.bootstrap(password,{},c.provider));
 release();await preparing;assert.equal(c.engine.unlocked,true);assert(await c.io.readConfig());
});
test('initial checkpoint failure leaves no enrollment config and can be retried',async()=>{
 const f=await setup(),c=await initialPublisher(f),write=c.io.writeState;let count=0;
 c.io.writeState=async(...args)=>{await write(...args);if(++count===2)throw Error('checkpoint reply lost');};
 await assert.rejects(c.engine.bootstrap(password,{},c.provider));assert.equal(await c.io.readConfig(),null);assert.equal(c.engine.unlocked,false);
 c.io.writeState=write;await c.engine.bootstrap(password,{},c.provider);c.engine.lock();
 const reopened=c.make();await reopened.open(password);assert.equal(reopened.unlocked,true);await reopened.sync(c.provider);assert.equal(reopened.status.state,'current');
});

test('identical full replica reuses encrypted verified checkpoints without re-uploading acknowledged history',async()=>{
 const f=await setup(),source=await initialPublisher(f);await source.engine.bootstrap(password,{},source.provider);
 const target=await f.client();for(const [p,raw]of source.local)target.local.set(p,raw);
 await target.io.writeConfig(await source.io.readConfig());for(const [slot,raw]of source.states)target.states.set(slot,raw);
 const uploads=f.uploads.length;await target.engine.open(password);assert.equal(target.engine.mode,'full');await target.engine.sync(target.provider);
 assert.equal(f.uploads.length,uploads);assert.equal(target.engine.status.pending,0);
 const edit={...f.records[1],revisionId:crypto.randomUUID(),parents:[f.records[1].revisionId],body:'new on the receiving full Mac'};
 const added=await target.add(edit);await target.engine.sync(target.provider);assert(f.server.has('rv-revision:'+added.revisionId));assert.equal(f.uploads.length,uploads+1);
});

test('bootstrap bounds publication to four records and waits for readback before enrollment',async()=>{
 const f=await setup(),c=await initialPublisher(f);
 for(let i=0;i<8;i++)await c.add(f.record('Native/extra-'+i+'.md',now));
 let active=0,maxActive=0,started=0,release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;}),write=f.transport.writeRecord;
 f.transport.writeRecord=async(...args)=>{active++;maxActive=Math.max(maxActive,active);if(++started===4)entered();await gate;try{await write(...args);}finally{active--;}};
 const preparing=c.engine.bootstrap(password,{},c.provider);await ready;
 assert.equal(started,4);assert.equal(await c.io.readConfig(),null);assert.equal(c.engine.unlocked,false);
 release();await preparing;assert.equal(maxActive,4);assert.equal(started,11);assert.equal(c.engine.status.done,11);assert.equal(c.engine.unlocked,true);
});

test('failed parallel bootstrap drains in-flight work and remains unavailable for retry until drained',async()=>{
 const f=await setup(),c=await initialPublisher(f);for(let i=0;i<5;i++)await c.add(f.record('Native/fail-'+i+'.md',now));
 let started=0,release,fail,entered;
 const gate=new Promise(resolve=>{release=resolve;}),failure=new Promise((_,reject)=>{fail=reject;}),ready=new Promise(resolve=>{entered=resolve;});
 f.transport.writeRecord=async()=>{const n=++started;if(n===4)entered();if(n===1)return failure;await gate;};
 const preparing=c.engine.bootstrap(password,{},c.provider);await ready;fail(Error('synthetic readback failure'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(c.engine.preparing,true);
 await assert.rejects(c.engine.bootstrap(password,{},c.provider));assert.equal(await c.io.readConfig(),null);
 release();await assert.rejects(preparing);assert.equal(started,4);assert.equal(c.engine.preparing,false);assert.equal(c.engine.unlocked,false);
 assert.equal([...f.server.keys()].filter(id=>id.startsWith('rv-revision:')).length,0);
});

test('locking during parallel initial readback cannot publish enrollment or descriptors',async()=>{
 const f=await setup(),c=await initialPublisher(f);let entered,release;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 f.transport.writeRecord=async()=>{entered();await gate;};
 const preparing=c.engine.bootstrap(password,{},c.provider);await ready;c.engine.lock();release();
 await assert.rejects(preparing);assert.equal(c.engine.unlocked,false);assert.equal(await c.io.readConfig(),null);
 assert.equal([...f.server.keys()].filter(id=>id.startsWith('rv-revision:')).length,0);
});

test('empty notebooks replicate regardless of age, tombstones stay out of archive and can hydrate for restore',async()=>{
 const f=await setup(),a=await f.client(),b=await f.client();await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 const folder=f.record('Native/Empty notebook','2020-01-01T00:00:00.000Z','',{kind:'folder',mime:'application/x-cipherfold-folder'});
 await a.add(folder);await a.engine.sync(a.provider);await b.engine.sync(b.provider);assert(b.local.has(recordPath(folder)));
 const base=f.records[1],deleted={...base,revisionId:crypto.randomUUID(),parents:[base.revisionId],deleted:true};await a.add(deleted);await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 assert(!b.engine.archive().some(e=>e.objectId===base.objectId));assert(b.engine.archive({deleted:true}).some(e=>e.revisionId===deleted.revisionId));assert(b.local.has(recordPath(deleted)));
 const fresh=await f.client();await fresh.engine.sync(fresh.provider);assert(fresh.local.has(recordPath(folder)));assert(!fresh.local.has(recordPath(deleted)));assert(!fresh.local.has(recordPath(base)));
 await fresh.engine.pin(base.objectId);await fresh.engine.sync(fresh.provider);assert(fresh.local.has(recordPath(deleted)));
 const {deleted:_,...plain}=deleted,restored={...plain,revisionId:crypto.randomUUID(),parents:[deleted.revisionId]};await a.add(restored);await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 assert(b.engine.archive().some(e=>e.revisionId===restored.revisionId));assert.equal(b.engine.archive({deleted:true}).length,0);
});
test('an offline delete and simultaneous edit are both acknowledged as a conflict, never last-writer-wins',async()=>{
 const f=await setup(),a=await f.client(),b=await f.client();await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 const base=f.records[1],deleted={...base,revisionId:crypto.randomUUID(),parents:[base.revisionId],deleted:true},edit={...base,revisionId:crypto.randomUUID(),parents:[base.revisionId],body:'OFFLINE_RETAINED'};
 await a.add(deleted);await b.add(edit);const connect=f.transport.connect;f.transport.connect=async()=>{throw Error('offline');};await assert.rejects(a.engine.sync(a.provider));assert.equal(a.engine.status.pending,1);
 f.transport.connect=connect;await b.engine.sync(b.provider);await a.engine.sync(a.provider);await b.engine.sync(b.provider);
 assert.equal(b.engine.status.conflicts,1);assert(f.files.has(recordPath(deleted)));assert(f.files.has(recordPath(edit)));assert.equal(b.engine.status.pending,0);
});
