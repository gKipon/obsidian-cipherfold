import {descriptor} from './replica-model.mjs';
import { createVault, unlockVault, encryptRecord, decryptRecord, bytesToBase64, base64ToBytes, LIMITS, parseHeaderJSON, parseEnvelopeJSON, encryptCatalog, decryptCatalog, ciphertextDigest } from './crypto.mjs';

const ROOT = 'CipherfoldStore';
const HEADER = `${ROOT}/vault.rvkey`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const FILE = new RegExp(`^${ROOT}/(${UUID})_(${UUID})\\.renc$`);
const MAX_FILES = 50000;
// A local write ceiling cannot cap independently edited offline replicas.
// Keep merged overflow readable; this separate hard bound is only a resource guard.
const MAX_READ_FILES = 60000;
const MAX_JSON = LIMITS.envelopeBytes;
const canonical = v => Array.isArray(v) ? '['+v.map(canonical).join(',')+']'
  : v!==null && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);
const same = (a,b) => canonical(a) === canonical(b);
const clone = value => structuredClone(value);
function fail(message = 'Encrypted store is unavailable or damaged') { throw new Error(message); }

export class SecureStore {
  folder = ROOT;
  #fingerprints=new Map(); #invalidated=new Set(); #adapter; #key = null; #header = null; #records = new Map(); #generation = 0; #queue = Promise.resolve();
  #externalParents=new Map();
  #unlockKey; #catalogIO; #catalog=new Map(); #digests=new Map(); #catalogDirty=false;
  lastUnlockMetrics=null;
  constructor(adapter, {catalog,unlockKey=unlockVault} = {}) { this.#adapter = adapter; this.#catalogIO=catalog; this.#unlockKey=unlockKey; }
  get isUnlocked() { return this.#key !== null; }
  async isInitialized() { return this.#adapter.exists(HEADER); }
  #serial(fn) {
    const result = this.#queue.then(fn);
    this.#queue = result.catch(() => {});
    return result;
  }
  #session() {
    if (!this.#key || !this.#header) fail('Unlock the store first');
    return {key:this.#key,header:clone(this.#header),generation:this.#generation};
  }
  #assertSession(s) {
    if (!this.#key || s.generation !== this.#generation) fail('Store locked; unlock and retry');
  }
  async #headerRead() {
    const text = await this.#adapter.read(HEADER);
    if (typeof text !== 'string' || text.length > 16384) fail();
    try { return parseHeaderJSON(text); } catch { fail(); }
  }
  async #assertHeader(s) {
    if (!same(await this.#headerRead(),s.header)) fail('Key header changed. Lock and unlock again');
    this.#assertSession(s);
  }
  initialize(password) {
    const generation = this.#generation;
    return this.#serial(async () => {
      if (generation !== this.#generation) fail('Creation cancelled');
      if (await this.isInitialized()) fail('Store already exists; use unlock');
      if (await this.#adapter.exists(ROOT)) {
        const before = await this.#adapter.list(ROOT);
        if (before.files.length || before.folders.length) fail('Folder already contains data; creation cancelled');
      } else await this.#adapter.mkdir(ROOT);
      const {header,key} = await createVault(password);
      const exists = await this.isInitialized();
      if (generation !== this.#generation || exists) fail('State changed; creation cancelled');
      await this.#adapter.write(HEADER,JSON.stringify(header));
      if (!same(await this.#headerRead(),header)) fail('Unable to verify the saved key header');
      if (generation !== this.#generation) fail('Store created but locked');
      this.#header=header;this.#key=key;this.#records.clear();this.#fingerprints.clear();this.#invalidated.clear();
    });
  }
  unlock(password, {onProgress, fullScan=false, replicaEntries=[]} = {}) {
    const generation = ++this.#generation;
    this.#key=null;this.#header=null;this.#records.clear();this.#fingerprints.clear();this.#invalidated.clear();
    this.#catalog.clear();this.#digests.clear();this.#catalogDirty=false;this.lastUnlockMetrics=null;
    return this.#serial(async () => {
      const started=performance.now(),metrics={kdfMs:0,catalogMs:0,scanMs:0,catalogSaveMs:0,records:0,lazyAttachments:0,decryptedRecords:0,ciphertextBytes:0,catalogState:'disabled'};
      const progress=(stage,done=0,total=0)=>{try{onProgress?.({stage,done,total,elapsedMs:performance.now()-started});}catch{}};
      try {
      progress('key');
      if (generation !== this.#generation) fail('Unlock cancelled');
      const header = await this.#headerRead();
      if (generation !== this.#generation) fail('Unlock cancelled');
      const kdfStarted=performance.now();
      const key = await this.#unlockKey(header,password);
      metrics.kdfMs=performance.now()-kdfStarted;
      if (generation !== this.#generation) fail('Unlock cancelled');
      if (!same(await this.#headerRead(),header)) fail('Key header changed while unlocking');
      if (generation !== this.#generation) fail('Unlock cancelled');
      this.#header=header;this.#key=key;this.setReplicaCatalogue(replicaEntries);
      if(this.#catalogIO&&!fullScan){
        progress('catalog');const t=performance.now();
        try{
          const text=await this.#catalogIO.read();
          if(text){const entries=await decryptCatalog(header,key,text);this.#assertSession({generation});for(const entry of entries)this.#catalog.set(entry.metadata.revisionId,entry);metrics.catalogState='loaded';}
          else metrics.catalogState='missing';
        }catch{this.#catalog.clear();metrics.catalogState='invalid-fallback';}
        metrics.catalogMs=performance.now()-t;
      }else if(fullScan)metrics.catalogState='full-scan';
      this.#assertSession({generation});
      const report=await this.#refresh({progress,metrics});
      metrics.totalMs=performance.now()-started;metrics.warnings=[...report.warnings];this.lastUnlockMetrics=metrics;
      return report;
      } catch (error) {
        if (generation === this.#generation) this.lock();
        throw error;
      }
    });
  }
  lock() { this.#externalParents.clear();this.#generation++;this.#key=null;this.#header=null;this.#records.clear();this.#fingerprints.clear();this.#invalidated.clear();this.#catalog.clear();this.#digests.clear();this.#catalogDirty=false; }
  refresh() { return this.#serial(() => this.#refresh()); }
  async #refresh({progress,metrics} = {}) {
    const started=performance.now();
    const s=this.#session();await this.#assertHeader(s);
    const listing = await this.#adapter.list(ROOT);
    const paths=listing.files.filter(p=>p.endsWith('.renc'));
    if (paths.length>MAX_READ_FILES) fail('Read limit exceeded; separate recovery required');
    const records=new Map(),fingerprints=new Map(),errors=[];
    let done=0;
    progress?.('records',0,paths.length);
    for(const path of paths) {
      this.#assertSession(s);
      try {
        const matched=FILE.exec(path);if(!matched) fail();
        const info=this.#adapter.stat?await this.#adapter.stat(path):null;
        const fingerprint=info?`${info.size}:${info.mtime}:${info.ctime}`:null;
        const previous=this.#records.get(matched[2]);
        if(fingerprint&&previous&&!this.#invalidated.has(path)&&this.#fingerprints.get(path)===fingerprint){
          records.set(previous.revisionId,previous);fingerprints.set(path,fingerprint);continue;
        }
        const raw=await this.#adapter.read(path);if(raw.length>MAX_JSON) fail();
        if(metrics)metrics.ciphertextBytes+=raw.length;
        const digest=await ciphertextDigest(raw);
        this.#digests.set(matched[2],digest);
        this.#assertSession(s);
        const cached=this.#catalog.get(matched[2]);
        if(cached&&cached.sha256===digest&&cached.metadata.objectId===matched[1]){
          records.set(matched[2],clone(cached.metadata));this.#digests.set(matched[2],digest);
          if(fingerprint)fingerprints.set(path,fingerprint);
          if(metrics)metrics.lazyAttachments++;
          continue;
        }
        const envelope=parseEnvelopeJSON(raw);
        if(envelope.objectId!==matched[1] || envelope.revisionId!==matched[2]) fail();
        const record=await decryptRecord(s.header,s.key,envelope);
        this.#assertSession(s);
        const retained=this.#retain(record);
        records.set(record.revisionId,retained);if(fingerprint)fingerprints.set(path,fingerprint);
        if(metrics)metrics.decryptedRecords++;
        if(digest&&record.kind==='attachment'){
          this.#digests.set(record.revisionId,digest);
          this.#catalog.set(record.revisionId,{sha256:digest,metadata:retained});this.#catalogDirty=true;
        }
      } catch {
        errors.push({path,reason:'Object validation failed; original file retained'});
      } finally {
        done++;
        if(done%16===0||done===paths.length){progress?.('records',done,paths.length);if(progress)await new Promise(resolve=>setTimeout(resolve,0));}
      }
    }
    this.#assertSession(s);
    // Parents can only supersede a revision of the SAME object.
    for(const record of records.values()) {
      for(const parent of record.parents) {
        const ancestor=records.get(parent)||this.#externalParents.get(parent);
        if(ancestor && (ancestor.objectId!==record.objectId||ancestor.kind!==record.kind)) {
          errors.push({path:`${ROOT}/${record.objectId}_${record.revisionId}.renc`,reason:'Invalid revision ancestry'});
          records.delete(record.revisionId);break;
        }
      }
    }
    this.#records=records;this.#fingerprints=fingerprints;this.#invalidated.clear();
    if(metrics){metrics.scanMs=performance.now()-started;metrics.records=paths.length;}
    const warnings=paths.length>=MAX_FILES?['50,000 revision limit reached: reads remain available, new saves are blocked. History is retained.']:[];
    if(!errors.length&&this.#catalogIO&&this.#catalogDirty){
      progress?.('cache');const t=performance.now();
      try{
        const entries=[...this.#catalog.values()].filter(e=>records.has(e.metadata.revisionId));
        const encrypted=await encryptCatalog(s.header,s.key,entries);this.#assertSession(s);
        await this.#catalogIO.write(encrypted);this.#assertSession(s);this.#catalogDirty=false;
      }catch{warnings.push('Encrypted catalog cache could not be saved; next unlock may take longer.');}
      if(metrics)metrics.catalogSaveMs=performance.now()-t;
    }
    this.#assertSession(s);return {errors,warnings};
  }
  setReplicaCatalogue(entries) {
    this.#externalParents=new Map(entries.map(e=>[e.revisionId,structuredClone(e)]));
  }
  catalogueHeads() {
    this.#session();const records=new Map([...this.#externalParents,...this.#records]);
    const parents=new Set([...records.values()].flatMap(r=>r.parents));
    return [...records.values()].filter(r=>!parents.has(r.revisionId));
  }
  list() {
    this.#session();
    const superseded=new Set();
    for(const r of this.#records.values()) {
      const todo=[...r.parents],seen=new Set();
      for(let i=0;i<todo.length;i++){
        const p=todo[i];if(seen.has(p))continue;seen.add(p);superseded.add(p);
        const parent=this.#records.get(p)||this.#externalParents.get(p);
        if(parent){if(parent.objectId!==r.objectId)fail();todo.push(...parent.parents);}
      }
    }
    let heads=[...this.#records.values()].filter(r=>!superseded.has(r.revisionId));
    const localObjects=new Set(heads.map(r=>r.objectId)),globalGroups=new Map();
    for(const record of this.catalogueHeads())if(localObjects.has(record.objectId)){
      const list=globalGroups.get(record.objectId)||[];list.push(record);globalGroups.set(record.objectId,list);
    }
    for(const [objectId,branches]of globalGroups)if(branches.length>1||branches.some(r=>r.deleted))heads=[...heads.filter(r=>r.objectId!==objectId),...branches];
    const count=new Map();for(const r of heads)count.set(r.objectId,(count.get(r.objectId)||0)+1);
    return heads.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.revisionId.localeCompare(b.revisionId))
      .map(r=>{const {body,...metadata}=r;return {...clone(metadata),available:this.#records.has(r.revisionId),isConflict:count.get(r.objectId)>1};});
  }
  get(objectId,revisionId) {
    this.#session();
    if(revisionId) {
      const r=this.#records.get(revisionId);return r?.objectId===objectId?clone(r):undefined;
    }
    const head=this.list().find(r=>r.objectId===objectId);return head?clone(this.#records.get(head.revisionId)):undefined;
  }
  async replicaEntries() {
    const session=this.#session(), records=[...this.#records.values()], entries=[];
    for(const record of records){
      const path=`${ROOT}/${record.objectId}_${record.revisionId}.renc`;
      let sha256=this.#digests.get(record.revisionId);
      const info=this.#adapter.stat?await this.#adapter.stat(path):null;
      let ciphertextBytes=info?.size;
      if(!sha256||!ciphertextBytes){const raw=await this.#adapter.read(path);sha256=await ciphertextDigest(raw);ciphertextBytes=new TextEncoder().encode(raw).length;this.#digests.set(record.revisionId,sha256);}
      this.#assertSession(session);
      entries.push(descriptor(record,{sha256,ciphertextBytes},[...this.#externalParents.values(),...records]));
    }
    return entries;
  }
  invalidate(path) { this.#invalidated.add(path); }
  #retain(record) {
    if(record.kind!=='attachment')return {...record,byteLength:new TextEncoder().encode(record.body).length};
    const {body,...metadata}=record;
    return {...metadata,byteLength:body.length/4*3-(body.endsWith('==')?2:body.endsWith('=')?1:0)};
  }
  async attachmentBytes(objectId,revisionId) {
    const session=this.#session(),metadata=this.#records.get(revisionId);
    if(!metadata||metadata.objectId!==objectId||metadata.kind!=='attachment')fail();
    await this.#assertHeader(session);
    const file=`${ROOT}/${objectId}_${revisionId}.renc`;
    const raw=await this.#adapter.read(file);
    const expected=this.#digests.get(revisionId);
    if(expected&&await ciphertextDigest(raw)!==expected)fail();
    const envelope=parseEnvelopeJSON(raw);
    const record=await decryptRecord(session.header,session.key,envelope);this.#assertSession(session);
    if(record.objectId!==objectId||record.revisionId!==revisionId||!same(this.#retain(record),metadata))fail();
    return base64ToBytes(record.body);
  }
  importRecord(input) {
    const session=this.#session(),record=clone(input);
    return this.#serial(async()=>{
      this.#assertSession(session);
      if(record.parents?.length||this.#records.has(record.revisionId)||[...this.#records.values()].some(r=>r.objectId===record.objectId))fail();
      return this.#write(session,record);
    });
  }
  saveNote(input) {
    const session=this.#session();
    // Capture caller-owned data now; later UI edits cannot mutate a queued save.
    const data=clone(input);
    return this.#serial(async()=>{
      this.#assertSession(session);
      if(typeof data.body!=='string'||new TextEncoder().encode(data.body).length>1024*1024) fail('Note size limit: 1 MiB');
      let objectId=data.objectId,parents=data.parents||[],createdAt=data.createdAt;
      if(!objectId) {objectId=crypto.randomUUID();parents=[];createdAt=new Date().toISOString();}
      else {
        if(!parents.length)fail('Editing requires a parent revision');
        for(const p of parents) if(this.#records.get(p)?.objectId!==objectId||this.#records.get(p)?.kind!=='note')fail('Parent revision unavailable');
        createdAt=this.#records.get(parents[0]).createdAt;
      }
      return this.#write(session,{objectId,revisionId:crypto.randomUUID(),parents,kind:'note',name:data.name,mime:'text/markdown',createdAt,updatedAt:new Date().toISOString(),body:data.body,...(data.deleted===true?{deleted:true}:{})});
    });
  }
  saveFolder(input) {
    const session=this.#session(),data=clone(input);
    return this.#serial(async()=>{
      this.#assertSession(session);const now=new Date().toISOString();
      const parents=data.parents||[];let createdAt=now;
      if(data.objectId){
        if(!parents.length||parents.some(id=>this.#records.get(id)?.objectId!==data.objectId||this.#records.get(id)?.kind!=='folder'))fail('Parent revision unavailable');
        createdAt=this.#records.get(parents[0]).createdAt;
      }else if(parents.length)fail();
      return this.#write(session,{objectId:data.objectId||crypto.randomUUID(),revisionId:crypto.randomUUID(),parents,kind:'folder',name:data.name,mime:'application/x-cipherfold-folder',createdAt,updatedAt:now,body:''});
    });
  }
  importAttachment(input) {
    const session=this.#session();const data={name:input.name,mime:input.mime,bytes:new Uint8Array(input.bytes)};
    return this.#serial(async()=>{
      this.#assertSession(session);
      if(data.bytes.length>LIMITS.attachmentBytes)fail('Attachment size limit: 16 MiB');
      const now=new Date().toISOString();
      return this.#write(session,{objectId:crypto.randomUUID(),revisionId:crypto.randomUUID(),parents:[],kind:'attachment',name:data.name,mime:data.mime||'application/octet-stream',createdAt:now,updatedAt:now,body:bytesToBase64(data.bytes)});
    });
  }
  async #write(session,record) {
    await this.#assertHeader(session);
    const listing=await this.#adapter.list(ROOT);
    if(listing.files.filter(path=>path.endsWith('.renc')).length>=MAX_FILES) {
      const error=new Error('50,000 encrypted revision limit reached. History retained; new edits were not saved.');
      error.code='STORE_CAPACITY';throw error;
    }
    const envelope=await encryptRecord(session.header,session.key,record);
    const decoded=await decryptRecord(session.header,session.key,envelope);
    if(!same(decoded,record))fail('Encryption verification failed');
    const path=`${ROOT}/${record.objectId}_${record.revisionId}.renc`;
    if(await this.#adapter.exists(path))fail('Revision already exists; write cancelled');
    this.#assertSession(session);
    await this.#adapter.write(path,JSON.stringify(envelope));
    const persisted=parseEnvelopeJSON(await this.#adapter.read(path));
    if(!same(await decryptRecord(session.header,session.key,persisted),record))fail('Read-back verification failed');
    this.#assertSession(session);
    this.#records.set(record.revisionId,this.#retain(record));
    return clone(record);
  }
}
