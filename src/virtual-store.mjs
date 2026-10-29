import { SecureStore } from './store.mjs';
import { base64ToBytes } from './crypto.mjs';

export const PHYSICAL_ROOT = 'CipherfoldStore';
export const VIRTUAL_ROOT = 'Native';
const SOURCE_ROOT = 'CipherfoldStore';
const encoder = new TextEncoder();
const messages = {
  LOCKED: 'Unlock the encrypted native store first.',
  INVALID_PATH: 'The virtual path is not supported.',
  NOT_FOUND: 'The virtual file is unavailable.',
  TYPE_MISMATCH: 'The virtual file type is not supported by this operation.',
  INVALID_DATA: 'The supplied data is not supported.',
  STALE_REVISION: 'The file changed; reload before saving.',
  STORE_CONFLICT: 'The encrypted store contains ambiguous file versions.',
  STORE_INVALID: 'The encrypted store could not be verified.',
  UNSUPPORTED_OPERATION: 'This operation is not supported by the native pilot.',
  STORE_CAPACITY: 'The encrypted revision limit has been reached.'
};
function fail(code) { const error = new Error(messages[code] || messages.STORE_INVALID); error.code = code; throw error; }
function safeError(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'STORE_INVALID';
  const result = new Error(messages[code]); result.code = code; return result;
}
function validUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}
function pathCheck(path, directory = false) {
  if (directory && (path === '' || path === VIRTUAL_ROOT)) return path;
  if (typeof path !== 'string' || path.length > 256 || !validUnicode(path)
    || !path.startsWith(`${VIRTUAL_ROOT}/`) || /[\\\u0000-\u001f\u007f]/.test(path)) fail('INVALID_PATH');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.trim() !== p
    || ['.obsidian', PHYSICAL_ROOT.toLowerCase(), SOURCE_ROOT.toLowerCase()].includes(p.toLowerCase()))) fail('INVALID_PATH');
  return path;
}
function fileType(path) {
  if (/\.md$/i.test(path)) return {binary:false,mime:'text/markdown'};
  const ext=path.slice(path.lastIndexOf('.')+1).toLowerCase();
  const types={png:'image/png',pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm'};
  return {binary:true,mime:types[ext]||'application/octet-stream'};
}
function key(path) { return path.normalize('NFC').toLowerCase(); }

// This adapter never receives logical names or plaintext. SecureStore's complete
// physical namespace is redirected, including the independently wrapped key.
function physicalAdapter(raw) {
  const forward = path => {
    if (path !== SOURCE_ROOT && !path.startsWith(`${SOURCE_ROOT}/`)) fail('INVALID_PATH');
    return PHYSICAL_ROOT + path.slice(SOURCE_ROOT.length);
  };
  const reverse = path => {
    if (typeof path !== 'string' || !path.startsWith(`${PHYSICAL_ROOT}/`)) fail('STORE_INVALID');
    return SOURCE_ROOT + path.slice(PHYSICAL_ROOT.length);
  };
  return {
    exists: path => raw.exists(forward(path)),
    mkdir: path => raw.mkdir(forward(path)),
    read: path => raw.read(forward(path)),
    ...(raw.stat?{stat:path=>raw.stat(forward(path))}:{}),
    write: (path, ciphertext) => raw.write(forward(path), ciphertext),
    async list(path) {
      const result = await raw.list(forward(path));
      return { files: result.files.map(reverse), folders: result.folders.map(reverse) };
    }
  };
}

/** An in-memory native projection; only authenticated encrypted records touch disk.
 * List/stat/exists are synchronous and throw while locked. read/readBinary and
 * all mutations are promises. Attachments are immutable in this bounded pilot.
 */
export class VirtualStore {
  folder = PHYSICAL_ROOT;
  #isolateConflicts=false; #conflicts=[]; #deleted=[]; #folders=new Map(); #secure; #files = new Map(); #observed = new Map(); #queue = Promise.resolve(); #generation = 0; #ready = false;
  constructor(rawAdapter, options={}) { this.#isolateConflicts=!!options.isolateConflicts;this.#secure = new SecureStore(physicalAdapter(rawAdapter), options); }
  get lastUnlockMetrics() { return this.#secure.lastUnlockMetrics?structuredClone(this.#secure.lastUnlockMetrics):null; }
  get isUnlocked() { return this.#ready && this.#secure.isUnlocked; }
  async isInitialized() {
    try { return await this.#secure.isInitialized(); } catch (error) { throw safeError(error); }
  }
  #session() { if (!this.isUnlocked) fail('LOCKED'); return this.#generation; }
  #assert(generation) { if (generation !== this.#generation || !this.#secure.isUnlocked) fail('LOCKED'); }
  #serial(operation) {
    const result = this.#queue.then(operation).catch(error => { throw safeError(error); });
    this.#queue = result.catch(() => {}); return result;
  }
  invalidate(path) { this.#secure.invalidate(SOURCE_ROOT+path.slice(PHYSICAL_ROOT.length)); }
  lock() { this.#generation++; this.#ready = false; this.#conflicts=[];this.#deleted=[];this.#folders.clear();this.#secure.lock(); this.#files.clear(); this.#observed.clear(); }
  initialize(password) {
    const generation = this.#generation;
    return this.#serial(async () => {
      if (generation !== this.#generation) fail('LOCKED');
      await this.#secure.initialize(password); this.#assert(generation);
      this.#files.clear(); this.#observed.clear(); this.#ready = true; return this.listFiles();
    });
  }
  unlock(password, options) {
    this.lock(); const generation = this.#generation;
    return this.#serial(async () => {
      try {
        if (generation !== this.#generation) fail('LOCKED');
        const report = await this.#secure.unlock(password, options); this.#assert(generation);
        this.#project(report); this.#ready = true; return this.listFiles();
      } catch (error) { if (generation === this.#generation) this.lock(); throw error; }
    });
  }
  refresh() {
    let generation; try { generation = this.#session(); } catch (error) { return Promise.reject(error); }
    return this.#serial(() => this.#refresh(generation));
  }
  async #refresh(generation) {
    try {
      this.#assert(generation); const report = await this.#secure.refresh(); this.#assert(generation);
      this.#project(report); return this.listFiles();
    } catch (error) { if (generation === this.#generation) this.lock(); throw error; }
  }
  #project(report) {
    if (report.errors?.length) fail('STORE_INVALID');
    const files = new Map(), folders=new Map(), names = new Set(), all=this.#secure.list();
    const ambiguous=new Set(all.filter(r=>r.isConflict).map(r=>r.objectId));
    const byPath=new Map();
    for(const record of all.filter(r=>!r.deleted)){const name=key(record.name),same=byPath.get(name)||[];same.push(record);byPath.set(name,same);}
    for(const [name,records]of byPath){
      if(new Set(records.map(r=>r.objectId)).size>1&&!(records.every(r=>r.kind==='folder')&&new Set(records.map(r=>r.name)).size===1))for(const r of records)ambiguous.add(r.objectId);
      const parts=name.split('/');parts.pop();
      while(parts.length>1){const ancestors=byPath.get(parts.join('/'))?.filter(r=>r.kind!=='folder');if(ancestors?.length)for(const r of [...records,...ancestors])ambiguous.add(r.objectId);parts.pop();}
    }
    this.#conflicts=all.filter(r=>ambiguous.has(r.objectId));
    if(this.#conflicts.length&&!this.#isolateConflicts)fail('STORE_CONFLICT');
    this.#deleted=all.filter(r=>r.deleted&&!ambiguous.has(r.objectId));
    for (const record of all) {
      pathCheck(record.name); const type = fileType(record.name);
      if(record.kind==='folder'){
        if(record.mime!=='application/x-cipherfold-folder')fail('STORE_INVALID');
        if(!ambiguous.has(record.objectId))folders.set(record.name,record);
        continue;
      }
      if (record.kind !== (type.binary ? 'attachment' : 'note') || record.mime !== type.mime) fail('STORE_INVALID');
      if(ambiguous.has(record.objectId)||record.deleted)continue;
      if (names.has(key(record.name))) fail('STORE_CONFLICT');
      names.add(key(record.name)); files.set(record.name, record);
    }
    for (const path of files.keys()) {
      const parts = path.split('/');
      for (let i = 2; i < parts.length; i++) if (names.has(key(parts.slice(0, i).join('/')))) fail('STORE_CONFLICT');
    }
    this.#files = files;this.#folders=folders;
  }
  #metadata(record) {
    const binary = record.kind === 'attachment';
    return { path: record.name, ctime: Date.parse(record.createdAt), mtime: Date.parse(record.updatedAt),
      size: record.byteLength,
      binary, mime: record.mime, objectId: record.objectId, revisionId: record.revisionId };
  }
  listFiles() { this.#session(); return [...this.#files.values()].map(r => this.#metadata(r)).sort((a, b) => a.path.localeCompare(b.path)); }
  reservedPaths() {
    this.#session();
    // Names of unloaded heads also belong to this vault. Include local projected
    // ancestors/conflicts while a newer body is still waiting to be downloaded.
    return [...new Set([...this.#secure.catalogueHeads().filter(r=>!r.deleted&&r.kind!=='folder').map(r=>r.name),
      ...this.#files.keys(), ...this.#conflicts.filter(r=>!r.deleted&&r.kind!=='folder').map(r=>r.name)])];
  }
  listFolders(){this.#session();return [...this.#folders.keys()].sort();}
  deletedNotes(){this.#session();return structuredClone(this.#deleted);}
  #collision(path, objectId, folder=false){
    const target=key(path);
    return this.#secure.catalogueHeads().some(r=>r.objectId!==objectId&&!r.deleted&&(
      r.kind==='folder' ? !folder&&(key(r.name)===target||key(r.name).startsWith(target+'/'))
      : key(r.name)===target||target.startsWith(key(r.name)+'/')||(!folder&&key(r.name).startsWith(target+'/'))));
  }
  exists(path) { this.#session(); pathCheck(path, true); return this.stat(path) !== null; }
  stat(path) {
    this.#session(); pathCheck(path, true);
    const record = this.#files.get(path);
    if (record) return { type: 'file', ...this.#metadata(record) };
    const explicit=this.#folders.get(path);
    if(explicit)return {type:'folder',ctime:Date.parse(explicit.createdAt),mtime:Date.parse(explicit.updatedAt),size:0};
    const children = [...this.#files.values()].filter(r => path === '' || r.name.startsWith(`${path}/`));
    if (path !== '' && path !== VIRTUAL_ROOT && !children.length&&![...this.#folders.keys()].some(p=>p.startsWith(path+'/'))) return null;
    return { type: 'folder', ctime: children.length ? Math.min(...children.map(r => Date.parse(r.createdAt))) : 0,
      mtime: children.length ? Math.max(...children.map(r => Date.parse(r.updatedAt))) : 0, size: 0 };
  }
  list(directory = '') {
    this.#session(); pathCheck(directory, true);
    if (!this.stat(directory) || this.#files.has(directory)) fail('NOT_FOUND');
    if (directory === '') return { files: [], folders: [VIRTUAL_ROOT] };
    const files = [], folders = new Set(), prefix = `${directory}/`;
    for (const path of this.#files.keys()) if (path.startsWith(prefix)) {
      const remainder = path.slice(prefix.length), slash = remainder.indexOf('/');
      if (slash < 0) files.push(path); else folders.add(prefix + remainder.slice(0, slash));
    }
    for(const path of this.#folders.keys())if(path.startsWith(prefix)){const rest=path.slice(prefix.length);folders.add(prefix+rest.split('/')[0]);}
    return { files: files.sort(), folders: [...folders].sort() };
  }
  async read(path) {
    this.#session(); pathCheck(path); const record = this.#files.get(path);
    if (!record) fail('NOT_FOUND'); if (record.kind !== 'note') fail('TYPE_MISMATCH');
    this.#observed.set(path, record.revisionId); return this.#secure.get(record.objectId,record.revisionId).body;
  }
  async readBinary(path) {
    this.#session(); pathCheck(path); const record = this.#files.get(path);
    if (!record) fail('NOT_FOUND'); if (record.kind !== 'attachment') fail('TYPE_MISMATCH');
    this.#observed.set(path, record.revisionId); return (await this.#secure.attachmentBytes(record.objectId,record.revisionId)).buffer;
  }
  write(path, text, options = {}) { return this.#write(path, text, options, false); }
  writeBinary(path, bytes, options = {}) { return this.#write(path, bytes, options, true); }
  #write(path, data, options, binary) {
    let generation, expected, snapshot;
    try {
      generation = this.#session(); pathCheck(path);
      if (fileType(path).binary !== binary) fail('TYPE_MISMATCH');
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_DATA');
      // Existing crypto format keeps its authenticated creation date on edits.
      // Importing historical timestamps needs a separate explicit migration API.
      if (Object.hasOwn(options, 'ctime') || Object.hasOwn(options, 'mtime')) fail('UNSUPPORTED_OPERATION');
      expected = Object.hasOwn(options, 'expectedRevisionId') ? options.expectedRevisionId
        : this.#observed.get(path) ?? this.#files.get(path)?.revisionId ?? null;
      if (expected !== null && typeof expected !== 'string') fail('INVALID_DATA');
      if (binary) {
        if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) fail('INVALID_DATA');
        snapshot = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)).slice();
        if (snapshot.byteLength > 16 * 1024 * 1024) fail('INVALID_DATA');
      } else { if (typeof data !== 'string' || !validUnicode(data)) fail('INVALID_DATA'); snapshot = data; }
    } catch (error) { return Promise.reject(safeError(error)); }
    return this.#serial(async () => {
      this.#assert(generation); await this.#refresh(generation); this.#assert(generation);
      const existing = this.#files.get(path);
      if(this.#conflicts.some(r=>key(r.name)===key(path)))fail('STORE_CONFLICT');
      if ((existing?.revisionId ?? null) !== expected) fail('STALE_REVISION');
      if (binary && existing) fail('UNSUPPORTED_OPERATION');
      const pathKey = key(path);
      if(this.#collision(path,existing?.objectId))fail('STORE_CONFLICT');
      for (const other of this.#files.keys()) {
        const otherKey = key(other);
        if (other !== path && (otherKey === pathKey || otherKey.startsWith(pathKey + '/') || pathKey.startsWith(otherKey + '/'))) fail('STORE_CONFLICT');
      }
      const record = binary
        ? await this.#secure.importAttachment({ name: path, mime: fileType(path).mime, bytes: snapshot })
        : await this.#secure.saveNote({ name: path, body: snapshot, ...(existing ? { objectId: existing.objectId, parents: [existing.revisionId] } : {}) });
      this.#assert(generation);
      // A concurrent replica write can land between refresh and persistence. Both
      // immutable branches survive; fail closed if that happened during the save.
      await this.#refresh(generation); this.#assert(generation);
      if (this.#files.get(path)?.revisionId !== record.revisionId){if(this.#isolateConflicts)return this.#metadata({...record,byteLength:binary?snapshot.byteLength:encoder.encode(snapshot).length});fail('STALE_REVISION');}
      this.#observed.set(path, record.revisionId); return this.#metadata(this.#files.get(path));
    });
  }
  rename(from, to) {
    if(this.isUnlocked&&this.stat(from)?.type==='folder')return this.#renameFolder(from,to);
    let generation, expected;
    try {
      generation = this.#session(); pathCheck(from); pathCheck(to);
      if (fileType(from).binary || fileType(to).binary) fail('UNSUPPORTED_OPERATION');
      expected = this.#observed.get(from) ?? this.#files.get(from)?.revisionId;
      if (!expected) fail('NOT_FOUND');
    } catch (error) { return Promise.reject(safeError(error)); }
    return this.#serial(async () => {
      this.#assert(generation); await this.#refresh(generation); this.#assert(generation);
      const existing = this.#files.get(from);
      if (!existing || existing.revisionId !== expected) fail('STALE_REVISION');
      if (from === to) return this.#metadata(existing);
      const targetKey = key(to);
      if(this.#collision(to,existing.objectId))fail('STORE_CONFLICT');
      for (const other of this.#files.keys()) {
        if (other === from) continue;
        const otherKey = key(other);
        if (otherKey === targetKey || otherKey.startsWith(targetKey + '/') || targetKey.startsWith(otherKey + '/')) fail('STORE_CONFLICT');
      }
      const record = await this.#secure.saveNote({name:to,
        body:this.#secure.get(existing.objectId, existing.revisionId).body,
        objectId:existing.objectId, parents:[existing.revisionId]});
      this.#assert(generation); await this.#refresh(generation); this.#assert(generation);
      if (this.#files.get(to)?.revisionId !== record.revisionId) fail('STALE_REVISION');
      // Retain the old observed revision: a delayed old-path save must not
      // silently recreate the renamed note as a different object.
      this.#observed.set(from, existing.revisionId);
      this.#observed.set(to, record.revisionId);
      return this.#metadata(this.#files.get(to));
    });
  }
  replicaEntries(){this.#session();return this.#secure.replicaEntries();}
  setReplicaCatalogue(entries){this.#session();this.#secure.setReplicaCatalogue(entries);}
  conflicts(){this.#session();return structuredClone(this.#conflicts);}
  readRevision(objectId,revisionId){this.#session();const r=this.#secure.get(objectId,revisionId);if(!r||r.kind!=='note')fail('NOT_FOUND');return r.body;}
  saveBranch(path,body,expectedRevisionId){
    const generation=this.#session();pathCheck(path);
    return this.#serial(async()=>{
      this.#assert(generation);await this.#refresh(generation);
      const records=await this.#secure.replicaEntries(),source=records.find(r=>r.revisionId===expectedRevisionId&&r.name===path&&r.kind==='note');
      if(!source)fail('STALE_REVISION');
      const saved=await this.#secure.saveNote({name:path,body,objectId:source.objectId,parents:[expectedRevisionId]});
      this.#assert(generation);await this.#refresh(generation);return this.#metadata({...saved,byteLength:encoder.encode(body).length});
    });
  }
  resolve(objectId,parents,name,body){
    const generation=this.#session();pathCheck(name);
    return this.#serial(async()=>{
      await this.#refresh(generation);this.#assert(generation);
      const current=this.#secure.list().filter(r=>r.objectId===objectId);
      if(!current.length||current.some(r=>r.kind!=='note'||!r.available)||JSON.stringify(current.map(r=>r.revisionId).sort())!==JSON.stringify([...parents].sort()))fail('STALE_REVISION');
      if(this.#collision(name,objectId))fail('STORE_CONFLICT');
      const saved=await this.#secure.saveNote({objectId,parents,name,body});this.#assert(generation);await this.#refresh(generation);
      return this.#metadata({...saved,byteLength:encoder.encode(body).length});
    });
  }
  remove(path) {
    let generation,expected;
    try{generation=this.#session();pathCheck(path);const record=this.#files.get(path);if(!record)fail('NOT_FOUND');if(record.kind!=='note')fail('UNSUPPORTED_OPERATION');expected=record.revisionId;}catch(e){return Promise.reject(safeError(e));}
    return this.#serial(async()=>{
      await this.#refresh(generation);this.#assert(generation);const record=this.#files.get(path);
      if(!record||record.revisionId!==expected)fail('STALE_REVISION');
      const saved=await this.#secure.saveNote({objectId:record.objectId,parents:[expected],name:path,body:this.#secure.get(record.objectId,expected).body,deleted:true});
      this.#assert(generation);await this.#refresh(generation);return this.#metadata({...saved,byteLength:encoder.encode(saved.body).length});
    });
  }
  restore(objectId,revisionId,path){
    const generation=this.#session();pathCheck(path);
    if(fileType(path).binary)fail('UNSUPPORTED_OPERATION');
    return this.#serial(async()=>{
      await this.#refresh(generation);this.#assert(generation);
      const current=this.#secure.catalogueHeads().filter(r=>r.objectId===objectId),record=this.#secure.get(objectId,revisionId);
      if(current.length!==1||current[0].revisionId!==revisionId||!record?.deleted)fail('STALE_REVISION');
      if(this.#collision(path,objectId))fail('STORE_CONFLICT');
      const saved=await this.#secure.saveNote({objectId,parents:[revisionId],name:path,body:record.body});
      this.#assert(generation);await this.#refresh(generation);return this.#metadata({...saved,byteLength:encoder.encode(saved.body).length});
    });
  }
  mkdir(path){
    let generation;try{generation=this.#session();pathCheck(path,true);}catch(e){return Promise.reject(safeError(e));}
    return this.#serial(async()=>{
      await this.#refresh(generation);this.#assert(generation);if(path===''||path===VIRTUAL_ROOT)return;
      if(this.#collision(path,null,true)||this.#conflicts.some(r=>key(r.name)===key(path)))fail('STORE_CONFLICT');
      if(this.#folders.has(path))return;
      if(this.#secure.catalogueHeads().some(r=>r.kind==='folder'&&key(r.name)===key(path)))fail('STORE_CONFLICT');
      await this.#secure.saveFolder({name:path});this.#assert(generation);await this.#refresh(generation);
    });
  }
  #renameFolder(from,to){
    let generation,expected;try{generation=this.#session();pathCheck(from);pathCheck(to);expected=this.#folders.get(from)?.revisionId;if(!expected)fail('UNSUPPORTED_OPERATION');}catch(e){return Promise.reject(safeError(e));}
    return this.#serial(async()=>{
      await this.#refresh(generation);this.#assert(generation);const source=this.#folders.get(from),heads=this.#secure.catalogueHeads().filter(r=>!r.deleted);
      if(!source||source.revisionId!==expected)fail('STALE_REVISION');
      if(from===to)return;
      if(key(to).startsWith(key(from)+'/'))fail('INVALID_PATH');
      // Only empty notebooks can move atomically in one immutable record.
      if(heads.some(r=>key(r.name).startsWith(key(from)+'/')))fail('UNSUPPORTED_OPERATION');
      if(heads.filter(r=>key(r.name)===key(from)).length!==1||heads.some(r=>r.objectId!==source.objectId&&(key(r.name)===key(to)||key(r.name).startsWith(key(to)+'/')))||this.#collision(to,source.objectId,true))fail('STORE_CONFLICT');
      await this.#secure.saveFolder({objectId:source.objectId,parents:[expected],name:to});this.#assert(generation);await this.#refresh(generation);
    });
  }
}
