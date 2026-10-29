// Browser-only WebCrypto. See ../docs/FORMAT.md for the format.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER_SCHEMA = 'cipherfold-vault/header/v1';
const OBJECT_SCHEMA = 'cipherfold-vault/object/v1';
const ERROR = 'Secure vault operation failed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const knownKeys = new WeakMap();
export const LIMITS = Object.freeze({ noteBytes: 1024 * 1024, attachmentBytes: 16 * 1024 * 1024,
  plaintextBytes: 24 * 1024 * 1024, envelopeBytes: 33 * 1024 * 1024,
  headerBytes: 4096, parents: 64, passwordMin: 4, passwordMax: 1024,
  minIterations: 600000, maxIterations: 2000000 });

function check(value) { if (!value) throw new Error(ERROR); }
async function guarded(fn) { try { return await fn(); } catch { throw new Error(ERROR); } }
function guardedSync(fn) { try { return fn(); } catch { throw new Error(ERROR); } }
function unicode(value) {
  check(typeof value === 'string');
  // TextEncoder replaces lone surrogates. Reject them instead of silently changing text.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); check(next >= 0xdc00 && next <= 0xdfff); }
    else check(c < 0xdc00 || c > 0xdfff);
  }
  return value;
}
function exact(value, names) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).length === names.length && names.every(name =>
    Object.hasOwn(descriptors, name) && Object.hasOwn(descriptors[name], 'value') && descriptors[name].enumerable));
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function b64(bytes, url = true) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const encoded = btoa(binary);
  return url ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encoded;
}
function unb64(text, max, length, url = true) {
  check(typeof text === 'string' && text.length <= Math.ceil(max / 3) * 4);
  // Avoid a repeated capture/group on multi-megabyte attachments (engine stack limits).
  check(url ? B64URL.test(text) : text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text));
  const binary = atob(url ? text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=') : text);
  check(binary.length <= max && (length === undefined || binary.length === length));
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  check(b64(bytes, url) === text);
  return bytes;
}
export function bytesToBase64(bytes) { return guardedSync(() => {
  check(bytes instanceof Uint8Array && bytes.length <= LIMITS.attachmentBytes); return b64(bytes, false);
}); }
export function base64ToBytes(text) { return guardedSync(() => unb64(text, LIMITS.attachmentBytes, undefined, false)); }

// Duplicate keys are rejected before schema validation; JSON.parse alone loses them.
function parseJSON(text, max, maxArray = 256) {
  check(typeof text === 'string' && text.length <= max && encoder.encode(text).length <= max);
  let i = 0;
  const whitespace = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };
  const string = () => {
    check(text[i] === '"'); const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '"') return unicode(JSON.parse(text.slice(start, i)));
      if (char === '\\') i++;
    }
    throw new Error(ERROR);
  };
  const value = depth => {
    check(depth <= 8); whitespace();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; const object = {}; const seen = new Set(); whitespace();
      if (text[i] === '}') { i++; return object; }
      while (true) {
        whitespace(); const key = string(); check(!seen.has(key) && seen.size < 64); seen.add(key);
        whitespace(); check(text[i++] === ':');
        Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        whitespace(); const next = text[i++]; if (next === '}') return object; check(next === ',');
      }
    }
    if (text[i] === '[') {
      i++; const array = []; whitespace(); if (text[i] === ']') { i++; return array; }
      while (true) { check(array.length < maxArray); array.push(value(depth + 1)); whitespace(); const next = text[i++]; if (next === ']') return array; check(next === ','); }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, i)) { i += token.length; return result; }
    }
    const number = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    check(number); i += number[0].length; const result = Number(number[0]); check(Number.isFinite(result)); return result;
  };
  const result = value(0); whitespace(); check(i === text.length); return result;
}
function passwordBytes(password) {
  unicode(password); check([...password].length >= LIMITS.passwordMin && password.length <= LIMITS.passwordMax);
  return encoder.encode(password);
}
function validateHeader(header) {
  exact(header, ['schema', 'vaultId', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'wrappedKey']);
  check(header.schema === HEADER_SCHEMA && UUID.test(header.vaultId) && header.kdf === 'PBKDF2-HMAC-SHA256'
    && Number.isSafeInteger(header.iterations) && header.iterations >= LIMITS.minIterations
    && header.iterations <= LIMITS.maxIterations && header.cipher === 'AES-256-GCM');
  unb64(header.salt, 16, 16); unb64(header.iv, 12, 12); unb64(header.wrappedKey, 48, 48);
  return header;
}
function route(envelope) {
  return { schema: envelope.schema, vaultId: envelope.vaultId, objectId: envelope.objectId,
    revisionId: envelope.revisionId, parents: envelope.parents, iv: envelope.iv };
}
function validateRoute(value) {
  check(typeof value.vaultId === 'string' && UUID.test(value.vaultId)
    && typeof value.objectId === 'string' && UUID.test(value.objectId)
    && typeof value.revisionId === 'string' && UUID.test(value.revisionId));
  check(Array.isArray(value.parents) && value.parents.length <= LIMITS.parents
    && value.parents.every(parent => typeof parent === 'string' && UUID.test(parent) && parent !== value.revisionId)
    && new Set(value.parents).size === value.parents.length);
}
function validateEnvelope(envelope) {
  exact(envelope, ['schema', 'vaultId', 'objectId', 'revisionId', 'parents', 'iv', 'ciphertext']);
  check(envelope.schema === OBJECT_SCHEMA); validateRoute(envelope);
  unb64(envelope.iv, 12, 12);
  check(unb64(envelope.ciphertext, LIMITS.plaintextBytes + 16).length > 16);
  check(encoder.encode(canonical(envelope)).length <= LIMITS.envelopeBytes);
  return envelope;
}
function validateRecord(record) {
  exact(record, ['objectId', 'revisionId', 'parents', 'kind', 'name', 'mime', 'createdAt', 'updatedAt', 'body', ...(Object.hasOwn(record,'deleted')?['deleted']:[])]);
  if(Object.hasOwn(record,'deleted'))check(record.deleted===true&&record.kind==='note'&&record.parents.length>0);
  validateRoute({ ...record, vaultId: '00000000-0000-4000-8000-000000000000' });
  unicode(record.name); unicode(record.mime); unicode(record.body);
  check(record.name.length >= 1 && record.name.length <= 256 && record.name.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(record.name) && record.mime.length <= 256 && !/[\u0000-\u001f\u007f]/.test(record.mime));
  for (const timestamp of [record.createdAt, record.updatedAt]) {
    check(typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      && new Date(timestamp).toISOString() === timestamp);
  }
  check(record.updatedAt >= record.createdAt);
  if (record.kind === 'folder') check(record.mime==='application/x-cipherfold-folder'&&record.body==='');
  else if (record.kind === 'note') check(record.body.length <= LIMITS.noteBytes && encoder.encode(record.body).length <= LIMITS.noteBytes);
  else { check(record.kind === 'attachment'); unb64(record.body, LIMITS.attachmentBytes, undefined, false); }
  return record;
}
export function parseHeaderJSON(text) { return guardedSync(() => validateHeader(parseJSON(text, LIMITS.headerBytes))); }
export function parseEnvelopeJSON(text) { return guardedSync(() => validateEnvelope(parseJSON(text, LIMITS.envelopeBytes))); }
function wrapAAD(header) {
  const { wrappedKey, ...protectedHeader } = header;
  return encoder.encode(canonical({ domain: 'cipherfold-vault/key-wrap/v1', header: protectedHeader }));
}
function objectAAD(header, envelope) {
  return encoder.encode(canonical({ domain: 'cipherfold-vault/record/v1', header: { schema: header.schema, vaultId: header.vaultId }, route: route(envelope) }));
}
async function wrappingKey(header, password, usage) {
  const bytes = passwordBytes(password);
  let material;
  try { material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']); }
  finally { bytes.fill(0); }
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(header.salt, 16, 16), iterations: header.iterations },
    material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
async function dataKey(raw, header) {
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  knownKeys.set(key, canonical(header)); return key;
}
function validateKey(header, key) { check(knownKeys.get(key) === canonical(header)); }

export async function createVault(password) { return guarded(async () => {
  const bytes = passwordBytes(password); bytes.fill(0);
  const header = { schema: HEADER_SCHEMA, vaultId: crypto.randomUUID(), kdf: 'PBKDF2-HMAC-SHA256',
    iterations: LIMITS.minIterations, cipher: 'AES-256-GCM', salt: b64(crypto.getRandomValues(new Uint8Array(16))),
    iv: b64(crypto.getRandomValues(new Uint8Array(12))), wrappedKey: '' };
  const wrapping = await wrappingKey(header, password, 'encrypt');
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    header.wrappedKey = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: unb64(header.iv, 12, 12), additionalData: wrapAAD(header), tagLength: 128 }, wrapping, raw)));
    validateHeader(header); return { header, key: await dataKey(raw, header) };
  } finally { raw.fill(0); }
}); }
export async function unlockVault(header, password) { return guarded(async () => {
  validateHeader(header); const wrapping = await wrappingKey(header, password, 'decrypt');
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.iv, 12, 12),
    additionalData: wrapAAD(header), tagLength: 128 }, wrapping, unb64(header.wrappedKey, 48, 48)));
  try { check(raw.length === 32); return await dataKey(raw, header); } finally { raw.fill(0); }
}); }
export async function encryptRecord(header, key, record) { return guarded(async () => {
  validateHeader(header); validateKey(header, key); validateRecord(record);
  // Snapshot before the first await: callers cannot mutate routing/body mid-operation.
  const plaintext = encoder.encode(canonical(record)); check(plaintext.length <= LIMITS.plaintextBytes);
  const envelope = { schema: OBJECT_SCHEMA, vaultId: header.vaultId, objectId: record.objectId,
    revisionId: record.revisionId, parents: [...record.parents], iv: b64(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '' };
  const aad = objectAAD(header, envelope);
  try { envelope.ciphertext = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
    iv: unb64(envelope.iv, 12, 12), additionalData: aad, tagLength: 128 }, key, plaintext))); }
  finally { plaintext.fill(0); }
  return validateEnvelope(envelope);
}); }
export async function decryptRecord(header, key, envelope) { return guarded(async () => {
  validateHeader(header); validateKey(header, key); validateEnvelope(envelope); check(envelope.vaultId === header.vaultId);
  const expected = canonical({ objectId: envelope.objectId, revisionId: envelope.revisionId, parents: envelope.parents });
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv, 12, 12),
    additionalData: objectAAD(header, envelope), tagLength: 128 }, key, unb64(envelope.ciphertext, LIMITS.plaintextBytes + 16)));
  try {
    const record = validateRecord(parseJSON(decoder.decode(plaintext), LIMITS.plaintextBytes));
    check(canonical({ objectId: record.objectId, revisionId: record.revisionId, parents: record.parents }) === expected);
    return record;
  } finally { plaintext.fill(0); }
}); }

// Optional, device-local acceleration. Original immutable records remain the source
// of truth. This domain cannot be substituted for a record or a wrapped data key.
const CATALOG_SCHEMA = 'cipherfold-vault/attachment-catalog/v1';
const CATALOG_MAX = 32 * 1024 * 1024;
function catalogAAD(header) { return encoder.encode(canonical({ domain: CATALOG_SCHEMA, header })); }
function validateCatalog(entries) {
  check(Array.isArray(entries) && entries.length <= 60000);
  const revisions = new Set();
  for (const entry of entries) {
    exact(entry, ['sha256', 'metadata']);
    check(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256));
    const m = entry.metadata;
    exact(m, ['objectId', 'revisionId', 'parents', 'kind', 'name', 'mime', 'createdAt', 'updatedAt', 'byteLength']);
    const {byteLength, ...record} = m;
    check(record.kind === 'attachment' && Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= LIMITS.attachmentBytes);
    validateRecord({...record, body: ''});
    check(!revisions.has(m.revisionId)); revisions.add(m.revisionId);
  }
  return entries;
}
export async function ciphertextDigest(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function encryptCatalog(header, key, entries) { return guarded(async () => {
  validateHeader(header); validateKey(header, key); validateCatalog(entries);
  const plaintext = encoder.encode(canonical(entries)); check(plaintext.length <= CATALOG_MAX);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:catalogAAD(header), tagLength:128}, key, plaintext);
    return JSON.stringify({schema:CATALOG_SCHEMA, iv:b64(iv), ciphertext:b64(new Uint8Array(ciphertext))});
  } finally { plaintext.fill(0); }
}); }
export async function decryptCatalog(header, key, text) { return guarded(async () => {
  validateHeader(header); validateKey(header, key);
  const envelope = parseJSON(text, Math.ceil((CATALOG_MAX + 16) * 4 / 3) + 1024);
  exact(envelope, ['schema','iv','ciphertext']); check(envelope.schema === CATALOG_SCHEMA);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(envelope.iv,12,12),
    additionalData:catalogAAD(header), tagLength:128}, key, unb64(envelope.ciphertext,CATALOG_MAX+16)));
  try { return validateCatalog(parseJSON(decoder.decode(plaintext), CATALOG_MAX, 60000)); }
  finally { plaintext.fill(0); }
}); }

// Replication metadata/configuration has its own authenticated domain. The full
// wrapped header and logical document ID are bound so envelopes cannot be moved
// between vaults, purposes or immutable catalogue documents.
const REPLICA_SCHEMA = 'cipherfold-vault/replica/v1';
export function validateReplicaEntries(entries) { return guardedSync(() => {
  check(Array.isArray(entries) && entries.length <= 60000);
  const seen = new Set();
  for (const e of entries) {
    exact(e, ['objectId','revisionId','parents','kind','name','mime','createdAt','updatedAt','byteLength','attachments','sha256','ciphertextBytes',...(Object.hasOwn(e,'deleted')?['deleted']:[])]);
    const {byteLength, attachments, sha256, ciphertextBytes, ...record} = e;
    validateRecord({...record, body:''});
    check(Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= (record.kind === 'note' ? LIMITS.noteBytes : LIMITS.attachmentBytes));
    check(Number.isSafeInteger(ciphertextBytes) && ciphertextBytes > 0 && ciphertextBytes <= LIMITS.envelopeBytes);
    check(typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256));
    check(Array.isArray(attachments) && attachments.length <= 4096 && attachments.every(x => typeof x === 'string' && UUID.test(x)) && new Set(attachments).size === attachments.length);
    check(record.kind === 'note' || !attachments.length);
    if(record.kind==='folder')check(byteLength===0);
    check(!seen.has(record.revisionId)); seen.add(record.revisionId);
  }
  return entries;
}); }
function replicaAAD(header, context) {
  validateHeader(header);
  check(typeof context === 'string' && /^[a-z0-9:._-]{1,160}$/.test(context));
  return encoder.encode(canonical({domain:REPLICA_SCHEMA, header, context}));
}
export async function encryptReplicaMessage(header, key, context, value) { return guarded(async () => {
  validateKey(header,key); const aad=replicaAAD(header,context);
  const plaintext=encoder.encode(canonical(value)); check(plaintext.length<=CATALOG_MAX);
  // Validate the supported JSON shape/depth before storing anything.
  parseJSON(decoder.decode(plaintext),CATALOG_MAX,60000);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  try { return JSON.stringify({schema:REPLICA_SCHEMA,iv:b64(iv),ciphertext:b64(new Uint8Array(await crypto.subtle.encrypt(
    {name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,plaintext)))}); }
  finally { plaintext.fill(0); }
}); }
export async function decryptReplicaMessage(header, key, context, text) { return guarded(async () => {
  validateKey(header,key); const aad=replicaAAD(header,context);
  const envelope=parseJSON(text,Math.ceil((CATALOG_MAX+16)*4/3)+1024);
  exact(envelope,['schema','iv','ciphertext']); check(envelope.schema===REPLICA_SCHEMA);
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(envelope.iv,12,12),additionalData:aad,tagLength:128},key,unb64(envelope.ciphertext,CATALOG_MAX+16)));
  try { return parseJSON(decoder.decode(plaintext),CATALOG_MAX,60000); }
  finally { plaintext.fill(0); }
}); }

// Password access slots are separate from the immutable header used by existing
// record/catalogue AAD. Historical headers/backups still open with old passwords.
const PASSWORD_SCHEMA='cipherfold-vault/password/v1';
function validatePasswordCredential(value){
  exact(value,['schema','generation','previous','headerHash','wrapped','proof']);
  check(value.schema===PASSWORD_SCHEMA&&Number.isSafeInteger(value.generation)&&value.generation>0&&value.generation<=1000000);
  check(value.previous===null?/^1$/.test(String(value.generation)):/^[0-9a-f]{64}$/.test(value.previous));
  check(/^[0-9a-f]{64}$/.test(value.headerHash)&&typeof value.proof==='string'&&value.proof.length<8192);
  validateHeader(value.wrapped);return value;
}
export function parsePasswordCredential(text){return guardedSync(()=>validatePasswordCredential(parseJSON(text,16384)));}
async function unwrapRaw(header,password){
  validateHeader(header);const wrapping=await wrappingKey(header,password,'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(header.iv,12,12),additionalData:wrapAAD(header),tagLength:128},wrapping,unb64(header.wrappedKey,48,48)));
}
export async function verifyPasswordCredential(header,key,value){return guarded(async()=>{
  validateHeader(header);validateKey(header,key);validatePasswordCredential(value);
  check(value.headerHash===await ciphertextDigest(canonical(header))&&value.wrapped.vaultId===header.vaultId);
  const {proof,...payload}=value;
  check(canonical(await decryptReplicaMessage(header,key,'password',proof))===canonical(payload));return value;
});}
export async function unlockPasswordKey(header,password,credential=null){return guarded(async()=>{
  if(!credential)return unlockVault(header,password);
  validateHeader(header);validatePasswordCredential(credential);
  const raw=await unwrapRaw(credential.wrapped,password);
  try{check(raw.length===32);const key=await dataKey(raw,header);await verifyPasswordCredential(header,key,credential);return key;}finally{raw.fill(0);}
});}
export async function makePasswordCredential(header,current,oldPassword,newPassword){return guarded(async()=>{
  check(oldPassword!==newPassword);const bytes=passwordBytes(newPassword);bytes.fill(0);
  const oldKey=await unlockPasswordKey(header,oldPassword,current);
  const raw=await unwrapRaw(current?.wrapped??header,oldPassword);
  try{
    check(raw.length===32);
    const wrapped={schema:HEADER_SCHEMA,vaultId:header.vaultId,kdf:'PBKDF2-HMAC-SHA256',iterations:LIMITS.minIterations,cipher:'AES-256-GCM',salt:b64(crypto.getRandomValues(new Uint8Array(16))),iv:b64(crypto.getRandomValues(new Uint8Array(12))),wrappedKey:''};
    const wrapping=await wrappingKey(wrapped,newPassword,'encrypt');
    wrapped.wrappedKey=b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:unb64(wrapped.iv,12,12),additionalData:wrapAAD(wrapped),tagLength:128},wrapping,raw)));
    const payload={schema:PASSWORD_SCHEMA,generation:(current?.generation??0)+1,previous:current?await ciphertextDigest(canonical(current)):null,headerHash:await ciphertextDigest(canonical(header)),wrapped};
    const result={...payload,proof:await encryptReplicaMessage(header,oldKey,'password',payload)};
    await unlockPasswordKey(header,newPassword,result);return validatePasswordCredential(result);
  }finally{raw.fill(0);}
});}
