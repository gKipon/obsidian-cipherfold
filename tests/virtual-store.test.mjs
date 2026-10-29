import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualStore, PHYSICAL_ROOT } from '../src/virtual-store.mjs';
import { SecureStore } from '../src/store.mjs';

const PASSWORD = 'synthetic-native-fixture-2026';
const NOTE = 'Native/Личные заметки/Кофе ☕.md';
const TEXT = 'Private note sentinel e1827. [[Вторая заметка]] #кофе';
class DiskAdapter {
  constructor(root) { this.root = root; }
  location(path) {
    assert.ok(path === PHYSICAL_ROOT || path.startsWith(PHYSICAL_ROOT + '/'));
    assert.ok(!path.includes('..') && !path.includes('\\'));
    return join(this.root, path);
  }
  async exists(path) { try { await stat(this.location(path)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  async mkdir(path) { await mkdir(this.location(path), { recursive: true }); }
  async read(path) { return readFile(this.location(path), 'utf8'); }
  async write(path, value) { assert.equal(typeof value, 'string'); await writeFile(this.location(path), value, { mode: 0o600 }); }
  async list(path) {
    const entries = await readdir(this.location(path), { withFileTypes: true });
    return { files: entries.filter(e => e.isFile()).map(e => path + '/' + e.name),
      folders: entries.filter(e => e.isDirectory()).map(e => path + '/' + e.name) };
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cipherfold-native-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = new DiskAdapter(directory), store = new VirtualStore(raw);
  await store.initialize(PASSWORD); return { directory, raw, store };
}
function compatible(raw) {
  const physical = path => PHYSICAL_ROOT + path.slice('CipherfoldStore'.length);
  return { exists: p => raw.exists(physical(p)), mkdir: p => raw.mkdir(physical(p)),
    read: p => raw.read(physical(p)), write: (p, s) => raw.write(physical(p), s),
    async list(p) { const result = await raw.list(physical(p)); return {
      files: result.files.map(f => 'CipherfoldStore' + f.slice(PHYSICAL_ROOT.length)),
      folders: result.folders.map(f => 'CipherfoldStore' + f.slice(PHYSICAL_ROOT.length)) }; } };
}
async function encryptedSnapshot(raw) {
  const { files } = await raw.list(PHYSICAL_ROOT);
  return Promise.all(files.sort().map(async path => [path, await raw.read(path)]));
}
function coded(code) { return error => error.code === code; }

test('rename and move preserve identity, body, creation date and immutable history across restart and another replica', async t => {
 const {raw,store}=await fixture(t);const first=await store.write(NOTE,TEXT);
 const before=await encryptedSnapshot(raw),remote=new VirtualStore(raw);await remote.unlock(PASSWORD);
 const target='Native/Другой блокнот/Новое имя.md';
 const renamed=await store.rename(NOTE,target);
 assert.equal(renamed.objectId,first.objectId);assert.equal(renamed.ctime,first.ctime);
 assert.notEqual(renamed.revisionId,first.revisionId);assert.equal(store.exists(NOTE),false);
 assert.equal(await store.read(target),TEXT);
 for(const [path,bytes] of before)assert.equal(await raw.read(path),bytes);
 const envelope=JSON.parse(await raw.read(`${PHYSICAL_ROOT}/${renamed.objectId}_${renamed.revisionId}.renc`));
 assert.deepEqual(envelope.parents,[first.revisionId]);
 await remote.refresh();assert.equal(remote.exists(NOTE),false);assert.equal(await remote.read(target),TEXT);
 store.lock();await store.unlock(PASSWORD);assert.deepEqual(store.listFiles(),[renamed]);
 assert.equal(await store.read(target),TEXT);
 const disk=JSON.stringify(await encryptedSnapshot(raw));for(const value of [NOTE,target,TEXT])assert(!disk.includes(value));
});

test('rename rejects collision, invalid destination, stale source and late old-path writes without destroying history', async t => {
 const {raw,store}=await fixture(t);await store.write(NOTE,TEXT);await store.write('Native/Exists.md','keep');
 await store.write('Native/Folder/Child.md','keep child');const before=await encryptedSnapshot(raw);
 for(const target of ['Native/exists.MD','Native/Folder.md/Bad/../x.md','outside.md','Native/Folder/Child.md/Nested.md'])
   await assert.rejects(store.rename(NOTE,target));
 assert.deepEqual(await encryptedSnapshot(raw),before);
 const remote=new VirtualStore(raw);await remote.unlock(PASSWORD);await remote.write(NOTE,'remote body');
 await assert.rejects(store.rename(NOTE,'Native/Changed.md'),coded('STALE_REVISION'));
 assert.equal(await store.read(NOTE),'remote body');
 await store.rename(NOTE,'Native/Changed.md');
 await assert.rejects(store.write(NOTE,'late old editor'),coded('STALE_REVISION'));
 assert.equal(await store.read('Native/Changed.md'),'remote body');
 const moved=await store.rename('Native/Changed.md','Native/changed.md');
 assert.equal(store.exists('Native/Changed.md'),false);assert.equal(moved.path,'Native/changed.md');
});

test('failed or locked rename preserves the old readable note; attachment and folder renames are explicit unsupported operations', async t => {
 const {raw,store}=await fixture(t);await store.write(NOTE,TEXT);const before=await encryptedSnapshot(raw),write=raw.write;
 raw.write=async()=>{throw Error('sensitive adapter text '+TEXT);};
 await assert.rejects(store.rename(NOTE,'Native/Failed.md'),e=>e.code==='STORE_INVALID'&&!e.message.includes(TEXT));
 raw.write=write;assert.deepEqual(await encryptedSnapshot(raw),before);assert.equal(await store.read(NOTE),TEXT);
 await assert.rejects(store.rename(NOTE,'Native/Bad.png'),coded('UNSUPPORTED_OPERATION'));
 await assert.rejects(store.rename('Native/Личные заметки','Native/Renamed'),coded('UNSUPPORTED_OPERATION'));
 store.lock();await assert.rejects(store.rename(NOTE,'Native/Locked.md'),coded('LOCKED'));
});

test('disk contains only encrypted UUID records; restart restores Unicode paths, body and metadata', async t => {
  const { raw, store } = await fixture(t);
  const first = await store.write(NOTE, TEXT);
  assert.equal(first.binary, false); assert.equal(first.size, new TextEncoder().encode(TEXT).length);
  assert.equal(first.path, NOTE);
  await store.read(NOTE);
  const second = await store.write(NOTE, TEXT + '\nEdited');
  assert.equal(second.objectId, first.objectId); assert.equal(second.ctime, first.ctime);
  assert.ok(second.mtime >= first.mtime); assert.notEqual(second.revisionId, first.revisionId);
  const disk = JSON.stringify(await encryptedSnapshot(raw));
  for (const sentinel of [NOTE, 'Личные', 'e1827', PASSWORD, TEXT, 'text/markdown']) assert.ok(!disk.includes(sentinel));
  assert.equal((await raw.list(PHYSICAL_ROOT)).files.length, 3);
  assert.ok((await raw.list(PHYSICAL_ROOT)).files.every(p => p.endsWith('/vault.rvkey') || /\/[0-9a-f-]+_[0-9a-f-]+\.renc$/.test(p)));
  store.lock(); assert.equal(store.isUnlocked, false); assert.throws(() => store.listFiles(), coded('LOCKED'));
  const restarted = new VirtualStore(raw); await restarted.unlock(PASSWORD);
  assert.equal(await restarted.read(NOTE), TEXT + '\nEdited');
  assert.deepEqual(restarted.listFiles(), [second]);
});

test('folders are derived without a plaintext physical tree; paths and listing are bounded', async t => {
  const { raw, store } = await fixture(t);
  await store.write(NOTE, TEXT); await store.write('Native/Second.md', 'Synthetic');
  assert.deepEqual(store.list(''), { files: [], folders: ['Native'] });
  assert.deepEqual(store.list('Native'), { files: ['Native/Second.md'], folders: ['Native/Личные заметки'] });
  assert.deepEqual(store.list('Native/Личные заметки'), { files: [NOTE], folders: [] });
  assert.equal(store.exists('Native/Личные заметки'), true);
  assert.equal(store.stat('Native/Личные заметки').type, 'folder');
  assert.equal(store.stat('Native/missing.md'), null);
  assert.equal(store.stat(NOTE).revisionId, store.listFiles().find(f => f.path === NOTE).revisionId);
  assert.deepEqual((await raw.list(PHYSICAL_ROOT)).folders, []);
  for (const path of ['/Native/absolute.md', 'Native/../escape.md', 'Native/./escape.md', 'Native//escape.md',
    'Native/Folder\\escape.md', 'Native/a\0.md', 'Native/.obsidian/data.md', 'Native/.ObSiDiAn/data.md',
    'CipherfoldStore/vault.rvkey', 'Native/CipherfoldStore/a.md', 'Native/ bad.md', 'Native/lone\ud800.md']) {
    await assert.rejects(store.write(path, 'blocked'), coded('INVALID_PATH'));
  }
  await assert.rejects(store.write('Native/attachment.txt', 'blocked'), coded('TYPE_MISMATCH'));
});

test('PNG PDF JPG attachments roundtrip exact bytes, snapshot input, and remain immutable', async t => {
  const { raw, store } = await fixture(t);
  const fixtures = [['png', Uint8Array.of(137, 80, 78, 71, 0, 255, 1)],
    ['pdf', new TextEncoder().encode('%PDF-1.4\nsynthetic-private-binary-1732')], ['jpg', Uint8Array.of(255, 216, 255, 224, 0, 16)]];
  for (const [extension, bytes] of fixtures) {
    const path = `Native/Attachments/private-file.${extension}`;
    const metadata = await store.writeBinary(path, bytes);
    assert.equal(metadata.binary, true); assert.equal(metadata.size, bytes.length);
    assert.deepEqual(new Uint8Array(await store.readBinary(path)), bytes);
    await assert.rejects(store.writeBinary(path, bytes), coded('UNSUPPORTED_OPERATION'));
    await assert.rejects(store.read(path), coded('TYPE_MISMATCH'));
  }
  const input = Uint8Array.of(4, 5, 6), expected = input.slice();
  const pending = store.writeBinary('Native/Snapshot.png', input); input.fill(99); await pending;
  assert.deepEqual(new Uint8Array(await store.readBinary('Native/Snapshot.png')), expected);
  const returned = new Uint8Array(await store.readBinary('Native/Snapshot.png')); returned.fill(0);
  assert.deepEqual(new Uint8Array(await store.readBinary('Native/Snapshot.png')), expected);
  const disk = JSON.stringify(await encryptedSnapshot(raw));
  for (const sentinel of ['private-file', 'synthetic-private-binary-1732', 'application/pdf', 'image/png']) assert.ok(!disk.includes(sentinel));
  const restart = new VirtualStore(raw); await restart.unlock(PASSWORD);
  assert.deepEqual(new Uint8Array(await restart.readBinary('Native/Attachments/private-file.pdf')), fixtures[1][1]);
  const before = await encryptedSnapshot(raw);
  await assert.rejects(store.writeBinary('Native/Huge.pdf', new Uint8Array(16 * 1024 * 1024 + 1)), coded('INVALID_DATA'));
  assert.deepEqual(await encryptedSnapshot(raw), before);
});

test('wrong password, lock and queued-save races reveal no records and do not write plaintext', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT);
  store.lock(); const before = await encryptedSnapshot(raw);
  await assert.rejects(store.write(NOTE, 'locked-body'), coded('LOCKED'));
  await assert.rejects(store.writeBinary('Native/X.png', Uint8Array.of(1)), coded('LOCKED'));
  await assert.rejects(store.read(NOTE), coded('LOCKED'));
  await assert.rejects(store.unlock('wrong-but-valid-length-password'), coded('STORE_INVALID'));
  assert.equal(store.isUnlocked, false);
  await store.unlock(PASSWORD);
  const pending = store.write('Native/Queued.md', 'must never reach disk'); store.lock();
  await assert.rejects(pending, coded('LOCKED'));
  assert.deepEqual(await encryptedSnapshot(raw), before);
  const unlock = store.unlock(PASSWORD); store.lock(); await assert.rejects(unlock, coded('LOCKED'));
  assert.equal(store.isUnlocked, false);
});

test('lock while password derivation/header verification is in flight cancels unlock', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT); store.lock();
  let release, arrive; const arrived = new Promise(resolve => arrive = resolve), gate = new Promise(resolve => release = resolve);
  const read = raw.read.bind(raw); let count = 0;
  raw.read = async path => { const result = await read(path);
    if (path.endsWith('/vault.rvkey') && ++count === 2) { arrive(); await gate; } return result; };
  const pending = store.unlock(PASSWORD); await arrived; store.lock(); release();
  await assert.rejects(pending); assert.equal(store.isUnlocked, false);
  assert.throws(() => store.listFiles(), coded('LOCKED'));
});

test('refresh reads remote update but stale editor saves cannot silently overwrite it', async t => {
  const { raw, store: local } = await fixture(t);
  const base = await local.write(NOTE, 'base'); assert.equal(await local.read(NOTE), 'base');
  const remote = new VirtualStore(raw); await remote.unlock(PASSWORD);
  const update = await remote.write(NOTE, 'remote'); await local.refresh();
  assert.equal(local.listFiles()[0].revisionId, update.revisionId);
  const before = await encryptedSnapshot(raw);
  await assert.rejects(local.write(NOTE, 'stale edit'), coded('STALE_REVISION'));
  await assert.rejects(local.write(NOTE, 'explicit stale', { expectedRevisionId: base.revisionId }), coded('STALE_REVISION'));
  assert.deepEqual(await encryptedSnapshot(raw), before); assert.equal(local.isUnlocked, true);
  assert.equal(await local.read(NOTE), 'remote');
  const saved = await local.write(NOTE, 'fresh edit'); assert.equal(saved.objectId, base.objectId);
  await remote.refresh(); assert.equal(await remote.read(NOTE), 'fresh edit');
});

test('write checks freshly arrived revisions even when caller did not request refresh', async t => {
  const { raw, store: local } = await fixture(t); await local.write(NOTE, 'base');
  const remote = new VirtualStore(raw); await remote.unlock(PASSWORD); await remote.write(NOTE, 'new');
  await assert.rejects(local.write(NOTE, 'unseen stale'), coded('STALE_REVISION'));
  assert.equal(await local.read(NOTE), 'new');
  await assert.rejects(local.write('Native/new.md', 'not-an-edit', { expectedRevisionId: 'missing' }), coded('STALE_REVISION'));
});

test('replica write in the refresh-to-persist window retains both branches and closes projection', async t => {
  const { raw, store: local } = await fixture(t); await local.write(NOTE, 'base');
  const remote = new VirtualStore(raw); await remote.unlock(PASSWORD);
  let release, arrive, paused = false;
  const arrived = new Promise(resolve => arrive = resolve), gate = new Promise(resolve => release = resolve);
  const write = raw.write.bind(raw);
  raw.write = async (path, value) => {
    if (!paused && path.endsWith('.renc')) { paused = true; arrive(); await gate; }
    return write(path, value);
  };
  const localSave = local.write(NOTE, 'local branch'); await arrived;
  await remote.write(NOTE, 'remote branch'); release();
  await assert.rejects(localSave, coded('STORE_CONFLICT'));
  assert.equal(local.isUnlocked, false);
  assert.equal((await raw.list(PHYSICAL_ROOT)).files.filter(p => p.endsWith('.renc')).length, 3);
  const recovery = new SecureStore(compatible(raw)); await recovery.unlock(PASSWORD);
  assert.deepEqual(new Set(recovery.list().map(r => recovery.get(r.objectId,r.revisionId).body)), new Set(['local branch', 'remote branch']));
});

test('failed disk write is sanitized and leaves the previous durable version intact', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT);
  const before = await encryptedSnapshot(raw), write = raw.write.bind(raw);
  raw.write = async () => { throw new Error('adapter diagnostics might contain ' + TEXT); };
  await assert.rejects(store.write(NOTE, 'unsaved'), error => error.code === 'STORE_INVALID' && !error.message.includes(TEXT));
  raw.write = write;
  assert.deepEqual(await encryptedSnapshot(raw), before); assert.equal(await store.read(NOTE), TEXT);
  store.lock(); await store.unlock(PASSWORD); assert.equal(await store.read(NOTE), TEXT);
});

test('unlock does not expose readiness while authenticated records are still being loaded', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT); store.lock();
  let release, arrive; const arrived = new Promise(resolve => arrive = resolve), gate = new Promise(resolve => release = resolve);
  const list = raw.list.bind(raw);
  raw.list = async path => { arrive(); await gate; return list(path); };
  const pending = store.unlock(PASSWORD); await arrived;
  assert.equal(store.isUnlocked, false); assert.throws(() => store.listFiles(), coded('LOCKED'));
  await assert.rejects(store.write('Native/TooEarly.md', 'blocked'), coded('LOCKED'));
  release(); await pending; assert.equal(store.isUnlocked, true); assert.equal(await store.read(NOTE), TEXT);
});

test('concurrent branches and independently created duplicate paths fail closed, preserving all ciphertext', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, 'base');
  const a = new SecureStore(compatible(raw)), b = new SecureStore(compatible(raw));
  await a.unlock(PASSWORD); await b.unlock(PASSWORD);
  const base = a.list()[0];
  await a.saveNote({ ...base, parents: [base.revisionId], body: 'left' });
  await b.saveNote({ ...base, parents: [base.revisionId], body: 'right' });
  const before = await encryptedSnapshot(raw);
  await assert.rejects(store.refresh(), coded('STORE_CONFLICT'));
  assert.equal(store.isUnlocked, false); assert.throws(() => store.listFiles(), coded('LOCKED'));
  await assert.rejects(store.unlock(PASSWORD), coded('STORE_CONFLICT'));
  assert.deepEqual(await encryptedSnapshot(raw), before);
  // A separate valid header with two unrelated object IDs using one logical path.
  const directory = await mkdtemp(join(tmpdir(), 'cipherfold-native-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const otherRaw = new DiskAdapter(directory), other = new SecureStore(compatible(otherRaw)); await other.initialize(PASSWORD);
  await other.saveNote({ name: NOTE, body: 'first object' }); await other.saveNote({ name: NOTE, body: 'second object' });
  await assert.rejects(new VirtualStore(otherRaw).unlock(PASSWORD), coded('STORE_CONFLICT'));
});

test('corruption, invalid encrypted paths, and header replacement fail closed with sanitized errors', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT);
  const path = (await raw.list(PHYSICAL_ROOT)).files.find(p => p.endsWith('.renc'));
  const original = await raw.read(path); await raw.write(path, '{corrupt sentinel-private-payload}');
  await assert.rejects(store.refresh(), error => error.code === 'STORE_INVALID' && !error.message.includes('sentinel'));
  assert.equal(store.isUnlocked, false); assert.equal(await raw.read(path), '{corrupt sentinel-private-payload}');
  await raw.write(path, original); await store.unlock(PASSWORD);
  const source = new SecureStore(compatible(raw)); await source.unlock(PASSWORD);
  await source.saveNote({ name: 'Native/.obsidian/private.md', body: 'must not surface' });
  await assert.rejects(store.refresh()); assert.equal(store.isUnlocked, false);
  // Header changes are rejected before a new revision is persisted.
  const header = JSON.parse(await raw.read(PHYSICAL_ROOT + '/vault.rvkey')); header.iv = 'invalid';
  await raw.write(PHYSICAL_ROOT + '/vault.rvkey', JSON.stringify(header));
  const fresh = new VirtualStore(raw); await assert.rejects(fresh.unlock(PASSWORD), coded('STORE_INVALID'));
  assert.equal(fresh.isUnlocked, false);
});

test('unsupported operations and file/folder/case collisions never discard existing content', async t => {
  const { raw, store } = await fixture(t); await store.write(NOTE, TEXT); const before = await encryptedSnapshot(raw);
  for (const action of [() => store.write(NOTE, 'timestamps', { ctime: 1 }), () => store.write(NOTE, 'timestamps', { mtime: 1 })]) {
    await assert.rejects(action(), coded('UNSUPPORTED_OPERATION'));
  }
  for (const path of ['Native/личные заметки/кофе ☕.MD', NOTE + '/nested.md', 'Native/Личные заметки']) {
    await assert.rejects(store.write(path, 'collision'));
  }
  assert.deepEqual(await encryptedSnapshot(raw), before); assert.equal(await store.read(NOTE), TEXT);
});

test('historical import preserves both dates across unlock and edit; attachments over old 5MiB limit survive',async t=>{
 const {raw,store}=await fixture(t);store.lock();const importer=new SecureStore(compatible(raw));await importer.unlock(PASSWORD);
 const now='2011-02-03T04:05:06.000Z',updated='2020-08-09T10:11:12.000Z';
 const note={objectId:crypto.randomUUID(),revisionId:crypto.randomUUID(),parents:[],kind:'note',name:'Native/History.md',mime:'text/markdown',createdAt:now,updatedAt:updated,body:'historical sentinel'};
 await importer.importRecord(note);assert.equal(importer.list()[0].body,undefined);
 const bytes=new Uint8Array(6*1024*1024);bytes[0]=137;bytes[bytes.length-1]=199;
 const attachment=await importer.importAttachment({name:'Native/Large.png',mime:'image/png',bytes});
 assert.equal(importer.get(attachment.objectId,attachment.revisionId).body,undefined);
 await store.unlock(PASSWORD);assert.equal(store.stat(note.name).ctime,Date.parse(now));assert.equal(store.stat(note.name).mtime,Date.parse(updated));
 assert.deepEqual(new Uint8Array(await store.readBinary('Native/Large.png')),bytes);
 await store.read(note.name);await store.write(note.name,'edited');assert.equal(store.stat(note.name).ctime,Date.parse(now));
});

test('unchanged encrypted files avoid repeated reads; invalidation detects corruption',async t=>{
 const {raw,store}=await fixture(t);await store.write(NOTE,TEXT);store.lock();let reads=0;
 const measured={...compatible(raw)};
 measured.stat=async p=>{const s=await stat(raw.location(PHYSICAL_ROOT+p.slice('CipherfoldStore'.length)));return {size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs};};
 const read=measured.read;measured.read=async p=>{if(p.endsWith('.renc'))reads++;return read(p);};
 const indexed=new SecureStore(measured);await indexed.unlock(PASSWORD);assert.equal(reads,1);await indexed.refresh();assert.equal(reads,1);
 const file=(await raw.list(PHYSICAL_ROOT)).files.find(p=>p.endsWith('.renc'));
 await raw.write(file,'broken');indexed.invalidate('CipherfoldStore'+file.slice(PHYSICAL_ROOT.length));const report=await indexed.refresh();assert.equal(report.errors.length,1);
});

test('selective graph supersedes an old local ancestor without downloading intermediate bodies',async t=>{
 const {raw,store,directory}=await fixture(t);const one=await store.write(NOTE,'one');const two=await store.write(NOTE,'two');const three=await store.write(NOTE,'three');const entries=await store.replicaEntries();
 await rm(join(directory,PHYSICAL_ROOT,`${two.objectId}_${two.revisionId}.renc`));
 const sparse=new VirtualStore(raw,{isolateConflicts:true});await sparse.unlock(PASSWORD,{replicaEntries:entries});
 assert.equal(sparse.conflicts().length,0);assert.equal(await sparse.read(NOTE),'three');assert.equal(sparse.stat(NOTE).revisionId,three.revisionId);
 const four=await sparse.write(NOTE,'four');assert.equal(sparse.conflicts().length,0);assert.notEqual(four.revisionId,one.revisionId);
});
test('conflicts isolate one note, explicit resolution checks all current parents and preserves branches',async t=>{
 const {raw,store}=await fixture(t);const initial=await store.write(NOTE,'base');await store.write('Native/Unaffected.md','keep');
 const secure=new SecureStore(compatible(raw));await secure.unlock(PASSWORD);
 const a=await secure.saveNote({objectId:initial.objectId,parents:[initial.revisionId],name:NOTE,body:'A'}),b=await secure.saveNote({objectId:initial.objectId,parents:[initial.revisionId],name:NOTE,body:'B'});
 const isolated=new VirtualStore(raw,{isolateConflicts:true});await isolated.unlock(PASSWORD);assert.equal(await isolated.read('Native/Unaffected.md'),'keep');assert.equal(isolated.conflicts().length,2);
 await assert.rejects(isolated.write(NOTE,'accidental new identity'));await assert.rejects(isolated.resolve(initial.objectId,[a.revisionId],NOTE,'bad'),coded('STALE_REVISION'));
 await isolated.resolve(initial.objectId,[a.revisionId,b.revisionId],NOTE,'A and B');assert.equal(await isolated.read(NOTE),'A and B');assert.equal(isolated.readRevision(initial.objectId,a.revisionId),'A');assert.equal(isolated.readRevision(initial.objectId,b.revisionId),'B');
});

test('missing conflict payload stays blocked and unloaded archive names are reserved',async t=>{
 const {raw,store,directory}=await fixture(t);const base=await store.write(NOTE,'base');await store.write('Native/Unaffected.md','safe');const old=await store.write('Native/Archive/Reserved.md','old');
 const secure=new SecureStore(compatible(raw));await secure.unlock(PASSWORD);const a=await secure.saveNote({objectId:base.objectId,parents:[base.revisionId],name:NOTE,body:'A'}),b=await secure.saveNote({objectId:base.objectId,parents:[base.revisionId],name:NOTE,body:'B'});
 const attachment=await secure.importAttachment({name:'Native/Archive/old.png',mime:'image/png',bytes:Uint8Array.of(1,2,3)});const catalogue=await secure.replicaEntries();
 for(const r of [b,old,attachment])await rm(join(directory,PHYSICAL_ROOT,`${r.objectId}_${r.revisionId}.renc`));
 const sparse=new VirtualStore(raw,{isolateConflicts:true});await sparse.unlock(PASSWORD,{replicaEntries:catalogue});
 const conflict=sparse.conflicts();assert.equal(conflict.length,2);assert.equal(conflict.filter(r=>r.available).length,1);assert.equal(await sparse.read('Native/Unaffected.md'),'safe');
 await assert.rejects(sparse.resolve(base.objectId,[a.revisionId,b.revisionId],NOTE,'incomplete'),coded('STALE_REVISION'));
 await assert.rejects(sparse.write('Native/Archive/Reserved.md','duplicate'),coded('STORE_CONFLICT'));
 await assert.rejects(sparse.rename('Native/Unaffected.md','Native/Archive/Reserved.md'),coded('STORE_CONFLICT'));
 const saved=await sparse.write('Native/Media reference.md','![[Native/Archive/old.png]]');const descriptor=(await sparse.replicaEntries()).find(r=>r.revisionId===saved.revisionId);assert.deepEqual(descriptor.attachments,[attachment.objectId]);
});

test('empty encrypted notebooks survive restart and peer refresh, rename before use, and reject unsafe parents',async t=>{
 const {raw,store}=await fixture(t);await store.mkdir('Native/New notebook');
 assert.equal(store.stat('Native/New notebook').type,'folder');assert.deepEqual(store.list('Native/New notebook'),{files:[],folders:[]});
 const before=await encryptedSnapshot(raw);await store.mkdir('Native/New notebook');assert.deepEqual(await encryptedSnapshot(raw),before);
 store.lock();await store.unlock(PASSWORD);assert.deepEqual(store.list('Native').folders,['Native/New notebook']);
 const peer=new VirtualStore(raw);await peer.unlock(PASSWORD);await store.rename('Native/New notebook','Native/Named notebook');await peer.refresh();
 assert.equal(peer.stat('Native/New notebook'),null);assert.equal(peer.stat('Native/Named notebook').type,'folder');
 await assert.rejects(store.rename('Native/Named notebook','Native/Named notebook/Nested'),coded('INVALID_PATH'));
 await store.write('Native/Named notebook/A.md','inside');await assert.rejects(store.rename('Native/Named notebook','Native/Moved'),coded('UNSUPPORTED_OPERATION'));
 await assert.rejects(store.mkdir('Native/Named notebook/A.md/Nested'),coded('STORE_CONFLICT'));
 await assert.rejects(store.mkdir('Native/named notebook'),coded('STORE_CONFLICT'));
 await assert.rejects(store.write('Native/Named notebook','replace folder'));
 const text=JSON.stringify(await encryptedSnapshot(raw));assert(!text.includes('Named notebook'));assert(!text.includes('inside'));
});
test('note trash and restore preserve body identity history and attachments across restart and another replica',async t=>{
 const {raw,store}=await fixture(t);const base=await store.write(NOTE,TEXT);await store.writeBinary('Native/pixel.png',Uint8Array.of(1,2,3));const before=await encryptedSnapshot(raw);
 const peer=new VirtualStore(raw);await peer.unlock(PASSWORD);const deleted=await store.remove(NOTE);assert.equal(deleted.objectId,base.objectId);assert.equal(store.exists(NOTE),false);
 assert.equal(store.deletedNotes().length,1);assert.equal(store.readRevision(base.objectId,deleted.revisionId),TEXT);assert.equal(store.stat('Native/pixel.png').type,'file');
 assert.throws(()=>store.restore(base.objectId,deleted.revisionId,'Native/Invalid.pdf'),coded('UNSUPPORTED_OPERATION'));
 await peer.refresh();assert.equal(peer.exists(NOTE),false);peer.lock();await peer.unlock(PASSWORD);assert.equal(peer.exists(NOTE),false);
 const restored=await peer.restore(base.objectId,deleted.revisionId,NOTE);assert.equal(restored.objectId,base.objectId);assert.equal(restored.ctime,base.ctime);assert.equal(await peer.read(NOTE),TEXT);
 await store.refresh();assert.equal(await store.read(NOTE),TEXT);assert.equal(store.deletedNotes().length,0);
 for(const [name,bytes]of before)assert.equal(await raw.read(name),bytes);
});
test('concurrent identical folder names coalesce but case aliases remain explicit conflicts',async t=>{
 const {raw,store}=await fixture(t);await store.mkdir('Native/Book');
 const secure=new SecureStore(compatible(raw));await secure.unlock(PASSWORD);await secure.saveFolder({name:'Native/Book'});
 await store.refresh();assert.deepEqual(store.listFolders(),['Native/Book']);
 await secure.saveFolder({name:'Native/book'});
 const peer=new VirtualStore(raw,{isolateConflicts:true});await peer.unlock(PASSWORD);assert.equal(peer.conflicts().length,3);assert.equal(peer.listFolders().length,0);
});
test('deleted names can be reused without stealing identity and restore rejects an occupied destination',async t=>{
 const {raw,store}=await fixture(t);const original=await store.write(NOTE,TEXT);const deleted=await store.remove(NOTE);
 const replacement=await store.write(NOTE,'new object',{expectedRevisionId:null});assert.notEqual(replacement.objectId,original.objectId);
 await assert.rejects(store.restore(original.objectId,deleted.revisionId,NOTE),coded('STORE_CONFLICT'));
 await store.restore(original.objectId,deleted.revisionId,'Native/Recovered.md');assert.equal(await store.read('Native/Recovered.md'),TEXT);assert.equal(await store.read(NOTE),'new object');
 const peer=new VirtualStore(raw);await peer.unlock(PASSWORD);assert.equal(peer.listFiles().length,2);
});
test('concurrent delete and edit retain both branches and require explicit resolution',async t=>{
 const {raw,store}=await fixture(t);const base=await store.write(NOTE,TEXT),secure=new SecureStore(compatible(raw));await secure.unlock(PASSWORD);
 const deleted=await store.remove(NOTE),edited=await secure.saveNote({objectId:base.objectId,parents:[base.revisionId],name:NOTE,body:'offline edit'});
 const peer=new VirtualStore(raw,{isolateConflicts:true});await peer.unlock(PASSWORD);assert.equal(peer.conflicts().length,2);assert.equal(peer.listFiles().length,0);
 await assert.rejects(peer.restore(base.objectId,deleted.revisionId,NOTE),coded('STALE_REVISION'));
 assert.equal(peer.readRevision(base.objectId,deleted.revisionId),TEXT);assert.equal(peer.readRevision(base.objectId,edited.revisionId),'offline edit');
 await peer.resolve(base.objectId,[deleted.revisionId,edited.revisionId],NOTE,'kept explicitly');assert.equal(await peer.read(NOTE),'kept explicitly');
});
test('authenticated remote deletion hides an old local copy even before hydration, never resurrects on refresh',async t=>{
 const {raw,store,directory}=await fixture(t);const first=await store.write(NOTE,TEXT),deleted=await store.remove(NOTE),catalogue=await store.replicaEntries();
 await rm(join(directory,PHYSICAL_ROOT,`${deleted.objectId}_${deleted.revisionId}.renc`));
 const sparse=new VirtualStore(raw,{isolateConflicts:true});await sparse.unlock(PASSWORD,{replicaEntries:catalogue});assert.equal(sparse.exists(NOTE),false);assert.equal(sparse.deletedNotes()[0].available,false);
 await sparse.refresh();assert.equal(sparse.exists(NOTE),false);await assert.rejects(sparse.restore(first.objectId,deleted.revisionId,NOTE),coded('STALE_REVISION'));
});
test('failed and stale deletes preserve original content; failed readback still retains durable deletion for recovery',async t=>{
 const {raw,store}=await fixture(t);await store.write(NOTE,TEXT);const peer=new VirtualStore(raw);await peer.unlock(PASSWORD);await peer.write(NOTE,'newer');
 await assert.rejects(store.remove(NOTE),coded('STALE_REVISION'));assert.equal(await store.read(NOTE),'newer');
 const write=raw.write;raw.write=async()=>{throw Error('write failed');};await assert.rejects(store.remove(NOTE));raw.write=write;assert.equal(await store.read(NOTE),'newer');
 const read=raw.read;let written=false;raw.write=async(...args)=>{await write.apply(raw,args);written=true;};raw.read=async p=>{if(written&&p.endsWith('.renc'))throw Error('readback interrupted');return read.call(raw,p);};
 await assert.rejects(store.remove(NOTE));raw.read=read;raw.write=write;store.lock();await store.unlock(PASSWORD);assert.equal(store.exists(NOTE),false);assert.equal(store.deletedNotes().length,1);
});
