import {requireReplica as check, recordPath, canonical} from './replica-model.mjs';
import {ciphertextDigest, LIMITS} from './crypto.mjs';
const utf8=new TextEncoder(), text=new TextDecoder('utf-8',{fatal:true});
const MAX_RESPONSE=48*1024*1024;
const READ_BATCH=32, ALL_DOCS='/_all_docs?include_docs=true&conflicts=true';
const REVISION=/^[1-9][0-9]{0,9}-[a-f0-9]{32}$/;
export function connectionFromSettings(s){
  check(s?.encrypt && s.encryptInternalMetadata && s.E2EEAlgorithm==='v2' && !s.enableCompression && !s.useEden && s.usePathObfuscation && s.idDerivationVersion===1,'TRANSPORT_SETTINGS');
  const fields=['couchDB_URI','couchDB_DBNAME','couchDB_USER','couchDB_PASSWORD','passphrase','useDynamicIterationCount','E2EEAlgorithm','encrypt','encryptInternalMetadata','enableCompression','useEden','usePathObfuscation','handleFilenameCaseSensitive','idDerivationVersion','idDerivationKey'];
  const settings=Object.fromEntries(fields.map(k=>[k,s[k]??false]));
  const u=new URL(settings.couchDB_URI);
  check(u.protocol==='https:' && !u.username && !u.password && !u.search && !u.hash && /^[a-z][a-z0-9_$()+-]{0,120}$/.test(settings.couchDB_DBNAME));
  check(['couchDB_USER','couchDB_PASSWORD','passphrase'].every(k=>typeof settings[k]==='string'&&settings[k].length>0&&settings[k].length<4096));
  check(/^[0-9a-f]{64}$/.test(settings.idDerivationKey));return settings;
}
function basic(s){let binary='';for(const b of utf8.encode(s.couchDB_USER+':'+s.couchDB_PASSWORD))binary+=String.fromCharCode(b);return 'Basic '+btoa(binary);}
/** Append-only transport. request returns {status,text}; no PouchDB, checkpoints,
 * DELETE, arbitrary URL, or shared document update is exposed. */
export class ReplicaTransport {
  constructor({settings,request,codecFactory}){
    this.settings=connectionFromSettings(settings);this.request=request;this.codecFactory=codecFactory;
    this.base=this.settings.couchDB_URI.replace(/\/$/,'')+'/'+this.settings.couchDB_DBNAME;
    this.stats={requests:0,receivedBytes:0,sentBytes:0,downloadedRecords:0};
  }
  async json(suffix,{method='GET',body,allowMissing=false,allowConflict=false}={}){
    check(method==='GET'||(method==='POST'&&(suffix==='/_bulk_docs'||suffix===ALL_DOCS||suffix==='/_bulk_get')));
    const serialized=body===undefined?undefined:JSON.stringify(body);
    check(!serialized||utf8.encode(serialized).length<=MAX_RESPONSE);
    const response=await this.request({url:this.base+suffix,method,headers:{Authorization:basic(this.settings),Accept:'application/json','Content-Type':'application/json'},body:serialized});
    this.stats.requests++;this.stats.sentBytes+=serialized?utf8.encode(serialized).length:0;
    check(response&&typeof response.text==='string'&&utf8.encode(response.text).length<=MAX_RESPONSE,'RESPONSE_LIMIT');
    this.stats.receivedBytes+=utf8.encode(response.text).length;
    if(response.status===404&&allowMissing)return null;
    if(response.status===409&&allowConflict)return null;
    check(response.status>=200&&response.status<300,'TRANSPORT_HTTP');
    try{return JSON.parse(response.text);}catch{check(false);}
  }
  async connect(){
    const parameters=await this.json('/_local/obsidian_livesync_sync_parameters');
    check(typeof parameters?.pbkdf2salt==='string'&&parameters.pbkdf2salt.length<=256,'TRANSPORT_SALT');
    const salt=Uint8Array.from(atob(parameters.pbkdf2salt),c=>c.charCodeAt(0));
    check(salt.length>=16&&salt.length<=128,'TRANSPORT_SALT');
    this.codec=await this.codecFactory(this.settings,salt);
  }
  async getDoc(id,options){
    return (await this.getDocs([id],options))[0];
  }
  async getDocs(ids,{identicalLeafConflicts=false}={}){
    check(Array.isArray(ids)&&ids.length>0&&ids.length<=READ_BATCH&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=512));
    // POST _all_docs is a read-only, bounded key lookup, including duplicate keys.
    const result=await this.json(ALL_DOCS,{method:'POST',body:{keys:ids}});
    check(Array.isArray(result.rows)&&result.rows.length===ids.length,'REMOTE_ROWS');
    const verified=new Map();
    return Promise.all(result.rows.map(async(row,index)=>{
      check(row.key===ids[index],'REMOTE_ID');
      if(row.error==='not_found'){check(!row.doc,'REMOTE_ROWS');return null;}
      check(!row.error&&row.doc&&!row.value?.deleted&&!row.doc._deleted,'REMOTE_CONFLICT');
      check(row.doc._id===ids[index],'REMOTE_ID');
      check(!Object.hasOwn(row.doc,'_conflicts')||Array.isArray(row.doc._conflicts),'REMOTE_CONFLICT');
      if(row.doc._conflicts?.length){
        check(identicalLeafConflicts&&ids[index].startsWith('h:'),'REMOTE_CONFLICT');
        const key=canonical(row.doc);
        if(!verified.has(key))verified.set(key,this.#verifyIdenticalLeaves(row.doc));
        await verified.get(key);
      }
      return row.doc;
    }));
  }
  // LiveSync and the direct publisher can encrypt the same immutable chunk
  // independently, creating different CouchDB revisions of identical content.
  // Authenticate every named branch and require exact decoded equality. Never
  // choose between different data, relax metadata/password checks, or delete a
  // revision. A later conflict will be checked on the next bounded read.
  async #verifyIdenticalLeaves(winner){
    check(this.codec&&winner.type==='leaf'&&REVISION.test(winner._rev),'REMOTE_CONFLICT');
    check(Array.isArray(winner._conflicts)&&winner._conflicts.length<=7,'REMOTE_CONFLICT_LIMIT');
    const revisions=[winner._rev,...winner._conflicts];
    check(revisions.every(r=>typeof r==='string'&&REVISION.test(r))&&new Set(revisions).size===revisions.length,'REMOTE_CONFLICT');
    const result=await this.json('/_bulk_get',{method:'POST',body:{docs:revisions.map(rev=>({id:winner._id,rev}))}});
    check(Array.isArray(result.results)&&result.results.length>0&&result.results.length<=revisions.length,'REMOTE_CONFLICT');
    const found=new Map();
    for(const item of result.results){
      check(item.id===winner._id&&Array.isArray(item.docs)&&item.docs.length>0&&item.docs.length<=revisions.length,'REMOTE_CONFLICT');
      for(const entry of item.docs){
        const doc=entry.ok;
        check(doc&&!entry.error&&doc._id===winner._id&&!doc._deleted&&revisions.includes(doc._rev)&&!found.has(doc._rev),'REMOTE_CONFLICT');
        found.set(doc._rev,doc);
      }
    }
    check(found.size===revisions.length,'REMOTE_CONFLICT');
    const normal=async raw=>{
      const doc=await this.codec.decode(structuredClone(raw));
      check(doc._id===winner._id&&doc.type==='leaf'&&typeof doc.data==='string'&&!doc._deleted,'REMOTE_CONFLICT');
      const {_rev,_conflicts,...content}=doc;return canonical(content);
    };
    const expected=await normal(winner);
    for(const rev of revisions)check(await normal(found.get(rev))===expected,'REMOTE_CHUNK_CONFLICT');
  }
  async appendDoc(id,doc){
    check(doc._id===id&&!doc._rev&&!doc._deleted);
    // JSON IDs avoid proxy path decoding of h:+ chunk identifiers. No _rev is
    // supplied, so an existing document can only conflict, never be replaced.
    const result=await this.json('/_bulk_docs',{method:'POST',body:{docs:[doc]}});
    check(Array.isArray(result)&&result.length===1&&result[0].id===id&&(!result[0].error||result[0].error==='conflict'),'APPEND_FAILED');
    return this.getDoc(id,{identicalLeafConflicts:id.startsWith('h:')&&doc.type==='leaf'}); // Read back the same immutable ID.
  }
  async comparePassword(id,previous,credential){
    check(/^rv-password:[0-9a-f-]{36}$/.test(id)&&(!previous||previous._id===id));
    const doc={_id:id,type:'rv-password',payload:JSON.stringify(credential),...(previous?{_rev:previous._rev}:{})};
    // The only mutable application document. CouchDB revision CAS prevents two
    // devices replacing each other's password. An uncertain POST is read back,
    // never blindly replayed with a different wrapper.
    try{await this.json('/_bulk_docs',{method:'POST',body:{docs:[doc]}});}catch{}
    const actual=await this.getDoc(id);
    check(actual?.type===doc.type&&actual.payload===doc.payload,'PASSWORD_NOT_CONFIRMED');return actual;
  }
  async listCatalog(){
    let start='rv-revision:',skip=0;const result=[];
    for(;;){
      const page=await this.json('/_all_docs?include_docs=true&conflicts=true&limit=128&startkey='+encodeURIComponent(JSON.stringify(start))+'&endkey='+encodeURIComponent(JSON.stringify('rv-revision:\ufff0'))+'&skip='+skip);
      check(Array.isArray(page.rows)&&page.rows.length<=128);
      for(const row of page.rows){check(row.doc&&!row.doc._deleted&&!row.doc._conflicts?.length,'REMOTE_CONFLICT');result.push(row.doc);}
      check(result.length<=60000,'CATALOGUE_LIMIT');
      if(page.rows.length<128)return result;
      const next=page.rows.at(-1).id;check(next!==start,'CATALOGUE_PAGINATION');start=next;skip=1;
    }
  }
  async readFile(path,expected){
    check(this.codec&&/^CipherfoldStore\/(?:vault\.rvkey|[0-9a-f-]{36}_[0-9a-f-]{36}\.renc)$/.test(path));
    const id=await this.codec.pathId(path),raw=await this.getDoc(id);
    return this.#readFile(path,expected,raw);
  }
  async #readFile(path,expected,raw){
    check(raw,'REMOTE_BODY_PENDING');
    const meta=await this.codec.decode(raw);
    check(meta.path===path&&!meta.deleted&&!meta._deleted&&!meta._conflicts?.length&&['plain','newnote'].includes(meta.type));
    check(Array.isArray(meta.children)&&meta.children.length<=1024&&!Object.keys(meta.eden||{}).length);
    check(Number.isSafeInteger(meta.size)&&meta.size>0&&meta.size<=LIMITS.envelopeBytes);
    if(expected)check(meta.size===expected.ciphertextBytes,'REMOTE_SIZE');
    const data=[];let encodedLength=0;
    for(let offset=0;offset<meta.children.length;offset+=READ_BATCH){
      const ids=meta.children.slice(offset,offset+READ_BATCH);
      check(ids.every(child=>typeof child==='string'&&child.startsWith('h:')&&child.length<=256));
      const chunks=await this.getDocs(ids,{identicalLeafConflicts:true});
      for(let i=0;i<ids.length;i++){
        const chunk=chunks[i];check(chunk,'REMOTE_CHUNK_PENDING');
        const decoded=await this.codec.decode(chunk);
        check(decoded._id===ids[i]&&decoded.type==='leaf'&&typeof decoded.data==='string');
        encodedLength+=decoded.data.length;check(encodedLength<=Math.ceil(LIMITS.envelopeBytes*4/3)+4096);
        data.push(decoded.data);
      }
    }
    const decoded=this.codec.content({...meta,data});
    const value=typeof decoded==='string'?decoded:text.decode(decoded);
    check(utf8.encode(value).length===meta.size,'REMOTE_SIZE');
    if(expected)check(await ciphertextDigest(value)===expected.sha256,'REMOTE_HASH');
    this.stats.downloadedRecords++;return value;
  }
  async writeFile(path,value,expected){
    check(this.codec&&utf8.encode(value).length===expected.ciphertextBytes&&await ciphertextDigest(value)===expected.sha256);
    const id=await this.codec.pathId(path),existing=await this.getDoc(id);
    if(existing){await this.#readFile(path,expected,existing);return;}
    const bytes=utf8.encode(value),children=[];
    for(let i=0;i<bytes.length;i+=48*1024){
      const pieces=await this.codec.encodeBinary(bytes.subarray(i,i+48*1024));
      check(Array.isArray(pieces)&&pieces.length===1);const piece=pieces[0];
      const child='h:+'+await this.codec.chunkId(piece);children.push(child);
      const raw=await this.appendDoc(child,await this.codec.encode({_id:child,type:'leaf',data:piece}));
      const actual=await this.codec.decode(raw);check(actual._id===child&&actual.type==='leaf'&&actual.data===piece,'REMOTE_CHUNK_MISMATCH');
    }
    const time=Date.now();
    await this.appendDoc(id,await this.codec.encode({_id:id,path,ctime:time,mtime:time,size:bytes.length,type:'newnote',children,eden:{}}));
    await this.readFile(path,expected); // Ack only after full independent byte readback.
  }
  async readRecord(entry){return this.readFile(recordPath(entry),entry);}
  async writeRecord(entry,value){return this.writeFile(recordPath(entry),value,entry);}
  async sequence(){const info=await this.json('');check(typeof info.update_seq==='string'||Number.isSafeInteger(info.update_seq));return info.update_seq;}
  async changes(since){return this.json('/_changes?feed=longpoll&timeout=25000&limit=128&since='+encodeURIComponent(since??'now'));}
}
