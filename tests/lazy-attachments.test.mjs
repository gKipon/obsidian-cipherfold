import test from 'node:test';
import assert from 'node:assert/strict';
import {SecureStore} from '../src/store.mjs';
import {createVault,encryptCatalog,decryptCatalog,ciphertextDigest} from '../src/crypto.mjs';

const password='synthetic-lazy-catalog-password';
function fixture(){
  const files=new Map(),reads=[];let cache=null,writes=0;
  const adapter={exists:async p=>files.has(p),mkdir:async()=>{},read:async p=>{reads.push(p);if(!files.has(p))throw Error('missing');return files.get(p);},
    write:async(p,s)=>{files.set(p,s);},list:async()=>({files:[...files.keys()],folders:[]}),
    // Deliberately constant timestamps: they must never authorize reuse after lock.
    stat:async p=>({size:files.get(p)?.length,mtime:1,ctime:1})};
  const catalog={read:async()=>cache,write:async text=>{cache=text;writes++;}};
  return {files,adapter,catalog,reads,get cache(){return cache;},set cache(v){cache=v;},get writes(){return writes;}};
}
async function seeded(){
  const f=fixture(),s=new SecureStore(f.adapter,{catalog:f.catalog});await s.initialize(password);
  const a=await s.importAttachment({name:'Native/Secret image.png',mime:'image/png',bytes:Uint8Array.of(137,80,78,71,10,255)});
  await s.saveNote({name:'Native/Secret note.md',body:'PRIVATE_NOTE_SENTINEL'});
  await s.refresh();s.lock();return {...f,f,a};
}

test('warm unlock authenticates catalog and hashes ciphertext without decrypting attachments; on-demand bytes match',async()=>{
  const {f,a}=await seeded();const s=new SecureStore(f.adapter,{catalog:f.catalog}),progress=[];
  const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let decryptions=0;
  crypto.subtle.decrypt=async(...args)=>{decryptions++;return decrypt(...args);};
  try{await s.unlock(password,{onProgress:p=>progress.push(p)});}finally{delete crypto.subtle.decrypt;}
  assert.equal(decryptions,3,'key unwrap + catalog + note, no attachment decryption');
  assert.equal(s.lastUnlockMetrics.lazyAttachments,1);assert.equal(s.lastUnlockMetrics.decryptedRecords,1);
  assert.equal(s.lastUnlockMetrics.catalogState,'loaded');assert.equal(s.list().length,2);
  assert.deepEqual(await s.attachmentBytes(a.objectId,a.revisionId),Uint8Array.of(137,80,78,71,10,255));
  for(const secret of ['Secret image','image/png','PRIVATE_NOTE_SENTINEL',password])assert(!f.cache.includes(secret));
  assert(progress.some(p=>p.stage==='key'));assert(progress.some(p=>p.stage==='records'&&p.done===2&&p.total===2));
  assert(!JSON.stringify(progress).includes('Secret'));
  s.lock();assert.throws(()=>s.list());
});

test('unchanged timestamps cannot hide modified attachment ciphertext during fast unlock',async()=>{
  const {f,a}=await seeded();const p=`CipherfoldStore/${a.objectId}_${a.revisionId}.renc`,e=JSON.parse(f.files.get(p));
  e.ciphertext=(e.ciphertext[0]==='A'?'B':'A')+e.ciphertext.slice(1);f.files.set(p,JSON.stringify(e));
  const s=new SecureStore(f.adapter,{catalog:f.catalog}),r=await s.unlock(password);
  assert.equal(r.errors.length,1);assert.equal(s.lastUnlockMetrics.lazyAttachments,0);
  await assert.rejects(s.attachmentBytes(a.objectId,a.revisionId));
});

test('corruption after unlock is rejected before attachment bytes are exposed',async()=>{
  const {f,a}=await seeded();const s=new SecureStore(f.adapter,{catalog:f.catalog});await s.unlock(password);
  const p=`CipherfoldStore/${a.objectId}_${a.revisionId}.renc`;f.files.set(p,f.files.get(p)+' ');
  await assert.rejects(s.attachmentBytes(a.objectId,a.revisionId));
});

test('damaged/missing local catalog falls back to authenticated records and rebuilds',async()=>{
  for(const value of [null,'broken',JSON.stringify({schema:'cipherfold-vault/attachment-catalog/v1',iv:'x',ciphertext:'y'})]){
    const {f}=await seeded();f.cache=value;
    const s=new SecureStore(f.adapter,{catalog:f.catalog});const r=await s.unlock(password);
    assert.equal(r.errors.length,0);assert.equal(s.lastUnlockMetrics.decryptedRecords,2);assert.equal(s.lastUnlockMetrics.lazyAttachments,0);
    s.lock();await s.unlock(password);assert.equal(s.lastUnlockMetrics.lazyAttachments,1);
  }
});

test('wrong password never opens catalog or writes acceleration data',async()=>{
  const {f}=await seeded();const before=f.cache,count=f.writes;let reads=0;
  const s=new SecureStore(f.adapter,{catalog:{...f.catalog,read:async()=>{reads++;return f.cache;}}});
  await assert.rejects(s.unlock('wrong-password-long-enough'));assert.equal(reads,0);assert.equal(f.cache,before);assert.equal(f.writes,count);assert.equal(s.isUnlocked,false);
});

test('catalog from a different vault cannot authenticate; valid records still recover',async()=>{
  const a=await seeded(),b=await seeded();b.f.cache=a.f.cache;
  const s=new SecureStore(b.f.adapter,{catalog:b.f.catalog});await s.unlock(password);
  assert.equal(s.lastUnlockMetrics.catalogState,'invalid-fallback');assert.equal(s.lastUnlockMetrics.decryptedRecords,2);
});

test('old client can add an attachment; new client authenticates it and retains warm entries',async()=>{
  const {f}=await seeded();const old=new SecureStore(f.adapter);await old.unlock(password);
  const a=await old.importAttachment({name:'Native/Remote.pdf',mime:'application/pdf',bytes:new TextEncoder().encode('%PDF synthetic')});
  const s=new SecureStore(f.adapter,{catalog:f.catalog});await s.unlock(password);
  assert.equal(s.lastUnlockMetrics.lazyAttachments,1);assert.equal(s.lastUnlockMetrics.decryptedRecords,2);
  assert.deepEqual(await s.attachmentBytes(a.objectId,a.revisionId),new TextEncoder().encode('%PDF synthetic'));
  s.lock();await s.unlock(password);assert.equal(s.lastUnlockMetrics.lazyAttachments,2);
  await old.refresh();assert.equal(old.list().length,3);
});

test('full scan bypasses cached metadata and does not alter any immutable record',async()=>{
  const {f}=await seeded();const before=[...f.files];const s=new SecureStore(f.adapter,{catalog:f.catalog});
  await s.unlock(password,{fullScan:true});assert.equal(s.lastUnlockMetrics.lazyAttachments,0);assert.equal(s.lastUnlockMetrics.decryptedRecords,2);
  assert.deepEqual([...f.files],before);
});

test('cache write failure is nonfatal and leaves original encrypted records readable',async()=>{
  const {f}=await seeded();f.cache=null;const before=[...f.files];
  const s=new SecureStore(f.adapter,{catalog:{read:async()=>null,write:async()=>{throw Error('disk full');}}});
  const r=await s.unlock(password);assert.equal(r.errors.length,0);assert.equal(r.warnings.length,1);assert.equal(s.list().length,2);assert.deepEqual([...f.files],before);
});

test('lock during catalog loading cancels the unlock and exposes no metadata',async()=>{
  const {f}=await seeded();let release,arrive;const gate=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);
  const s=new SecureStore(f.adapter,{catalog:{...f.catalog,read:async()=>{arrive();await gate;return f.cache;}}});
  const pending=s.unlock(password);await arrived;s.lock();release();await assert.rejects(pending);assert.equal(s.isUnlocked,false);assert.throws(()=>s.list());
});

test('catalog encryption rejects unsafe metadata and authenticates every byte',async()=>{
  const {header,key}=await createVault(password);
  const entries=[{sha256:await ciphertextDigest('synthetic ciphertext'),metadata:{objectId:crypto.randomUUID(),revisionId:crypto.randomUUID(),parents:[],kind:'attachment',name:'Native/A.png',mime:'image/png',createdAt:'2026-10-25T00:00:00.000Z',updatedAt:'2026-10-25T00:00:00.000Z',byteLength:42}}];
  const text=await encryptCatalog(header,key,entries);assert.deepEqual(await decryptCatalog(header,key,text),entries);
  for(const change of [{byteLength:-1},{byteLength:17*1024*1024},{kind:'note'},{body:'forbidden'}])await assert.rejects(encryptCatalog(header,key,[{...entries[0],metadata:{...entries[0].metadata,...change}}]));
  await assert.rejects(encryptCatalog(header,key,[entries[0],entries[0]]));
  const e=JSON.parse(text);e.ciphertext=(e.ciphertext[0]==='A'?'B':'A')+e.ciphertext.slice(1);await assert.rejects(decryptCatalog(header,key,JSON.stringify(e)));
});
