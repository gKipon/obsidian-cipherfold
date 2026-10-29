import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createVault, unlockVault, encryptRecord, decryptRecord, LIMITS,
  parseHeaderJSON, parseEnvelopeJSON, bytesToBase64, base64ToBytes } from '../src/crypto.mjs';
import { recoverSynthetic } from './helpers/recover-synthetic.mjs';

const password = 'synthetic-long-password-🔑';
const failure = { message: 'Secure vault operation failed' };
const clone = value => structuredClone(value);
const note = (changes = {}) => ({ objectId: crypto.randomUUID(), revisionId: crypto.randomUUID(), parents: [],
  kind: 'note', name: 'Синтетическая заметка 🔐', mime: 'text/markdown', createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z', body: '# Проверка\n café 漢字 😀\u0000\n', ...changes });
const fixture = await createVault(password);

test('Unicode note roundtrip, nonextractable key, no plaintext metadata outside ciphertext', async () => {
  const record = note({ parents: [crypto.randomUUID()] });
  const envelope = await encryptRecord(fixture.header, fixture.key, record);
  const unlocked = await unlockVault(clone(fixture.header), password);
  assert.deepEqual(await decryptRecord(fixture.header, unlocked, envelope), record);
  assert.equal(unlocked.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', unlocked));
  assert.deepEqual(Object.keys(envelope).sort(), ['schema', 'vaultId', 'objectId', 'revisionId', 'parents', 'iv', 'ciphertext'].sort());
  for (const text of [record.name, record.body, record.mime]) assert.equal(JSON.stringify(envelope).includes(text), false);
  assert.deepEqual(parseHeaderJSON(JSON.stringify(fixture.header)), fixture.header);
  assert.deepEqual(parseEnvelopeJSON(JSON.stringify(envelope)), envelope);
});

test('random data keys, vault IDs, salts, wrapping IVs and record IVs', async () => {
  const other = await createVault(password);
  for (const field of ['vaultId', 'salt', 'iv', 'wrappedKey']) assert.notEqual(fixture.header[field], other.header[field]);
  const record = note();
  const a = await encryptRecord(fixture.header, fixture.key, record);
  const b = await encryptRecord(fixture.header, fixture.key, record);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.ciphertext, b.ciphertext);
  await assert.rejects(encryptRecord(other.header, fixture.key, record), failure);
  await assert.rejects(decryptRecord(other.header, other.key, a), failure);
  await assert.rejects(decryptRecord(fixture.header, other.key, a), failure);
});

test('password policy, wrong password, and authenticated key-wrap header tampering', async () => {
  for (const bad of ['', '1', '12', '123', '😀😀', 'x'.repeat(1025), '\ud800'.repeat(12)]) await assert.rejects(createVault(bad), failure);
  await assert.rejects(unlockVault(fixture.header, 'wrong-long-password'), failure);
  for (const field of ['vaultId', 'salt', 'iv', 'wrappedKey', 'iterations', 'schema', 'cipher', 'kdf']) {
    const header = clone(fixture.header);
    if (field === 'vaultId') header[field] = crypto.randomUUID();
    else if (field === 'iterations') header[field]++;
    else if (['salt', 'iv', 'wrappedKey'].includes(field)) header[field] = (header[field][0] === 'A' ? 'B' : 'A') + header[field].slice(1);
    else header[field] += '-changed';
    await assert.rejects(unlockVault(header, password), failure);
  }
  const swapped = clone(fixture.header); swapped.wrappedKey = (await createVault(password)).header.wrappedKey;
  await assert.rejects(unlockVault(swapped, password), failure);
});

test('every public routing field, IV, ciphertext and tag is authenticated', async () => {
  const record = note({ parents: [crypto.randomUUID(), crypto.randomUUID()] });
  const original = await encryptRecord(fixture.header, fixture.key, record);
  for (const field of ['schema', 'vaultId', 'objectId', 'revisionId', 'parents', 'iv', 'ciphertext']) {
    const envelope = clone(original);
    if (['vaultId', 'objectId', 'revisionId'].includes(field)) envelope[field] = crypto.randomUUID();
    else if (field === 'parents') envelope.parents.reverse();
    else envelope[field] = (envelope[field][0] === 'A' ? 'B' : 'A') + envelope[field].slice(1);
    await assert.rejects(decryptRecord(fixture.header, fixture.key, envelope), failure);
  }
  const tag = clone(original); const raw = Buffer.from(tag.ciphertext, 'base64url'); raw[raw.length - 1] ^= 1; tag.ciphertext = raw.toString('base64url');
  await assert.rejects(decryptRecord(fixture.header, fixture.key, tag), failure);
  const removed = clone(original); removed.parents = []; await assert.rejects(decryptRecord(fixture.header, fixture.key, removed), failure);
});

test('independent WebCrypto unwrap/decrypt agrees; valid tags cannot hide routing mismatch or invalid plaintext', async () => {
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const encode = text => new TextEncoder().encode(text);
  const { wrappedKey, ...protectedHeader } = fixture.header;
  const material = await crypto.subtle.importKey('raw', encode(password), 'PBKDF2', false, ['deriveKey']);
  const wrapping = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000,
    salt: Buffer.from(fixture.header.salt, 'base64url') }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(fixture.header.iv, 'base64url'),
    additionalData: encode(canonical({ domain: 'cipherfold-vault/key-wrap/v1', header: protectedHeader })), tagLength: 128 }, wrapping, Buffer.from(wrappedKey, 'base64url')));
  assert.equal(raw.length, 32);
  const independent = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); raw.fill(0);
  const record = note(); const envelope = await encryptRecord(fixture.header, fixture.key, record);
  const { ciphertext, ...route } = envelope;
  const parameters = { name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64url'), tagLength: 128,
    additionalData: encode(canonical({ domain: 'cipherfold-vault/record/v1', header: { schema: fixture.header.schema, vaultId: fixture.header.vaultId }, route })) };
  const clear = await crypto.subtle.decrypt(parameters, independent, Buffer.from(ciphertext, 'base64url'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(clear)), record);
  for (const invalidPlaintext of [canonical({ ...record, objectId: crypto.randomUUID() }), canonical(record).replace('{', '{"kind":"note",'), canonical({ ...record, extra: true })]) {
    const forged = { ...envelope, ciphertext: Buffer.from(await crypto.subtle.encrypt(parameters, fixture.key, encode(invalidPlaintext))).toString('base64url') };
    await assert.rejects(decryptRecord(fixture.header, fixture.key, forged), failure);
  }
});

test('binary attachments including empty and maximum 16MiB survive canonical base64 roundtrip', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 128, 3, 42]), new Uint8Array(LIMITS.attachmentBytes).fill(0xa5)]) {
    const record = note({ kind: 'attachment', name: '../../synthetic.html', mime: 'text/html', body: bytesToBase64(bytes) });
    const envelope = await encryptRecord(fixture.header, fixture.key, record);
    const recovered = await decryptRecord(fixture.header, fixture.key, envelope);
    assert.deepEqual(base64ToBytes(recovered.body), bytes);
    assert.ok(JSON.stringify(envelope).length <= LIMITS.envelopeBytes);
  }
});

test('strict schema, Unicode, timestamp, data and parser bounds reject unsafe input', async () => {
  const badRecords = [note({ extra: true }), note({ name: '' }), note({ name: 'a'.repeat(257) }), note({ mime: 'x\n' }),
    note({ name: '\ud800' }), note({ body: '\udfff' }), note({ kind: 'html' }), note({ createdAt: '2026-02-30T00:00:00.000Z' }),
    note({ updatedAt: '2025-10-24T00:00:00.000Z' }), note({ body: 'я'.repeat(LIMITS.noteBytes / 2 + 1) }),
    note({ parents: Array.from({ length: 65 }, () => crypto.randomUUID()) }), note({ parents: ['../outside'] }),
    note({ kind: 'attachment', body: 'YQ' }), note({ kind: 'attachment', body: 'YR==' })];
  const duplicate = crypto.randomUUID(); badRecords.push(note({ parents: [duplicate, duplicate] }));
  for (const record of badRecords) await assert.rejects(encryptRecord(fixture.header, fixture.key, record), failure);
  assert.throws(() => bytesToBase64(new Uint8Array(LIMITS.attachmentBytes + 1)), failure);
  for (const iterations of [0, 599999, 2000001, 600000.5, '600000', Infinity]) {
    const header = { ...fixture.header, iterations }; await assert.rejects(unlockVault(header, password), failure);
  }
  assert.throws(() => parseHeaderJSON(JSON.stringify({ ...fixture.header, extra: true })), failure);
  assert.throws(() => parseHeaderJSON(JSON.stringify(fixture.header).replace('{', '{"schema":"duplicate",')), failure);
  assert.throws(() => parseHeaderJSON(' '.repeat(LIMITS.headerBytes + 1)), failure);
  assert.throws(() => parseEnvelopeJSON(' '.repeat(LIMITS.envelopeBytes + 1)), failure);
  assert.throws(() => parseHeaderJSON('{"nested":' + '['.repeat(10) + '0' + ']'.repeat(10) + '}'), failure);
  assert.throws(() => parseHeaderJSON('{"__proto__":{},"__proto__":{}}'), failure);
  assert.throws(() => parseHeaderJSON('{"x":1e999}'), failure);
  const envelope = await encryptRecord(fixture.header, fixture.key, note());
  for (const mutation of [{ ...envelope, ciphertext: 'A'.repeat(15 * 1024 * 1024) }, { ...envelope, iv: envelope.iv + '=' }, { ...envelope, extra: true }]) {
    await assert.rejects(decryptRecord(fixture.header, fixture.key, mutation), failure);
  }
});

test('mutable caller input cannot change an encryption already started', async () => {
  const record = note(); const expected = clone(record);
  const pending = encryptRecord(fixture.header, fixture.key, record);
  record.body = 'different'; record.parents.push(crypto.randomUUID());
  assert.deepEqual(await decryptRecord(fixture.header, fixture.key, await pending), expected);
});

test('recovery preserves revisions, outputs safe inert names, rejects wrong password/unsafe output and corrupt input', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cipherfold-crypto-test-'));
  try {
    const input = path.join(temporary, 'CipherfoldStore'); await mkdir(input);
    await writeFile(path.join(input, 'vault.rvkey'), JSON.stringify(fixture.header));
    const first = note();
    const records = [first, note({ kind: 'attachment', name: '../../escape.html', mime: 'text/html', body: bytesToBase64(new Uint8Array([0, 255, 128])) }),
      note({ objectId: first.objectId, body: 'A concurrent immutable head' })];
    for (const record of records) await writeFile(path.join(input, `${record.objectId}_${record.revisionId}.renc`), JSON.stringify(await encryptRecord(fixture.header, fixture.key, record)));
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'synthetic-recovery-wrong'), password: 'wrong-long-password', syntheticOnly: true }));
    assert.equal((await readdir(temporary)).length, 1);
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'unsafe'), password, syntheticOnly: true }));
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'synthetic-recovery-unacknowledged'), password }));
    const output = path.join(temporary, 'synthetic-recovery-valid');
    assert.deepEqual(await recoverSynthetic({ input, output, password, syntheticOnly: true }), { recovered: 3, execution: 'no_exec' });
    assert.equal((await lstat(output)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(output, `${records[0].objectId}_${records[0].revisionId}.txt`), 'utf8'), records[0].body);
    assert.equal(await readFile(path.join(output, `${records[2].objectId}_${records[2].revisionId}.txt`), 'utf8'), records[2].body);
    assert.deepEqual(new Uint8Array(await readFile(path.join(output, `${records[1].objectId}_${records[1].revisionId}.bin`))), new Uint8Array([0, 255, 128]));
    assert.equal((await readdir(output)).some(name => name.includes('escape')), false);
    await assert.rejects(recoverSynthetic({ input, output, password, syntheticOnly: true }));
    const child = spawn(process.execPath, [new URL('./helpers/recover-synthetic.mjs', import.meta.url).pathname, '--synthetic-only', '--input', input, '--output', path.join(temporary, 'synthetic-recovery-cli')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.stdin.end(password + '\n');
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0); assert.match(stdout, /Recovered 3 synthetic revisions/);
    assert.equal((stdout + stderr).includes(password), false);
    const mismatch = path.join(input, `${crypto.randomUUID()}_${records[0].revisionId}.renc`);
    await writeFile(mismatch, await readFile(path.join(input, `${records[0].objectId}_${records[0].revisionId}.renc`)));
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'synthetic-recovery-mismatch'), password, syntheticOnly: true }));
    assert.equal((await readdir(temporary)).includes('synthetic-recovery-mismatch'), false);
    await rm(mismatch);
    await symlink(path.join(input, `${records[0].objectId}_${records[0].revisionId}.renc`), mismatch);
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'synthetic-recovery-symlink'), password, syntheticOnly: true }));
    assert.equal((await readdir(temporary)).includes('synthetic-recovery-symlink'), false);
    await rm(mismatch);
    await writeFile(path.join(input, `${records[0].objectId}_${records[0].revisionId}.renc`), '{}');
    await assert.rejects(recoverSynthetic({ input, output: path.join(temporary, 'synthetic-recovery-corrupt'), password, syntheticOnly: true }));
    assert.equal((await readdir(temporary)).includes('synthetic-recovery-corrupt'), false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('encrypted notebook and note tombstone roundtrip; invalid lifecycle tags and bodies fail closed',async()=>{
 const folder=note({name:'Native/Empty notebook',kind:'folder',mime:'application/x-cipherfold-folder',body:''});
 const deleted=note({parents:[crypto.randomUUID()],deleted:true});
 for(const record of [folder,deleted])assert.deepEqual(await decryptRecord(fixture.header,fixture.key,await encryptRecord(fixture.header,fixture.key,record)),record);
 for(const bad of [{...folder,body:'not empty'},{...folder,mime:'text/markdown'},{...folder,deleted:true},{...deleted,deleted:false},{...deleted,parents:[]}])await assert.rejects(encryptRecord(fixture.header,fixture.key,bad),failure);
});
