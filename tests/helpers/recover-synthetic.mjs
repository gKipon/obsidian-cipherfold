#!/usr/bin/env node
// Offline, explicit synthetic-only plaintext export. Never opens or executes output.
import { lstat, readdir, open, mkdir, writeFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlockVault, decryptRecord, parseHeaderJSON, parseEnvelopeJSON, base64ToBytes, LIMITS } from '../../src/crypto.mjs';

const FAILURE = 'Synthetic recovery failed; no files were opened or executed.';
const OBJECT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.renc$/;
function insist(value) { if (!value) throw new Error(FAILURE); }
async function readBounded(file, max) {
  insist(Number.isInteger(constants.O_NOFOLLOW));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); insist(stat.isFile() && stat.size <= max);
    const buffer = new Uint8Array(max + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break; length += bytesRead;
    }
    insist(length <= max);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export async function recoverSynthetic({ input, output, password, syntheticOnly }) {
  try {
    insist(syntheticOnly === true && typeof input === 'string' && typeof output === 'string');
    const destination = path.resolve(output);
    insist(/^synthetic-recovery-[A-Za-z0-9_-]+$/.test(path.basename(destination)));
    const source = await realpath(input);
    insist((await lstat(source)).isDirectory());
    const parent = await realpath(path.dirname(destination));
    const target = path.join(parent, path.basename(destination));
    insist(target !== source && !target.startsWith(source + path.sep) && !source.startsWith(target + path.sep));
    try { await lstat(target); throw new Error(FAILURE); } catch (error) { insist(error.code === 'ENOENT'); }
    const header = parseHeaderJSON(await readBounded(path.join(source, 'vault.rvkey'), LIMITS.headerBytes));
    const key = await unlockVault(header, password);
    const entries = await readdir(source, { withFileTypes: true });
    insist(entries.length <= 10001 && entries.every(entry => entry.isFile()
      && (entry.name === 'vault.rvkey' || OBJECT_FILE.test(entry.name))));
    const files = entries.filter(entry => entry.name !== 'vault.rvkey').map(entry => entry.name).sort();
    async function decryptFile(filename) {
      const match = filename.match(OBJECT_FILE);
      const envelope = parseEnvelopeJSON(await readBounded(path.join(source, filename), LIMITS.envelopeBytes));
      insist(envelope.objectId === match[1] && envelope.revisionId === match[2]);
      return decryptRecord(header, key, envelope);
    }
    // Verify every object before creating any plaintext. Repeat per object to bound memory.
    for (const filename of files) await decryptFile(filename);
    await mkdir(target, { mode: 0o700 });
    for (const filename of files) {
      const record = await decryptFile(filename);
      const base = record.objectId + '_' + record.revisionId;
      // Names and MIME types remain inert metadata; even .html/.svg attachments use .bin.
      const content = record.kind === 'note' ? record.body : base64ToBytes(record.body);
      await writeFile(path.join(target, base + (record.kind === 'note' ? '.txt' : '.bin')), content, { mode: 0o600, flag: 'wx' });
      const { body, ...metadata } = record;
      await writeFile(path.join(target, base + '.metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    await writeFile(path.join(target, 'RECOVERY.txt'),
      'Synthetic plaintext recovery. Content is untrusted; no files were opened or executed.\n'
      + 'UUID filenames preserve each immutable revision, including conflicts.\n'
      + 'This export is plaintext. Remove it deliberately after synthetic testing.\n', { mode: 0o600, flag: 'wx' });
    return { recovered: files.length, execution: 'no_exec' };
  } catch { throw new Error(FAILURE); }
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let result = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { result += chunk; insist(result.length <= 1026); }
    result = result.replace(/\r?\n$/, ''); insist(!/[\r\n]/.test(result)); return result;
  }
  process.stderr.write('Synthetic vault password (hidden): ');
  process.stdin.setEncoding('utf8'); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let result = '';
    const cleanup = () => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error(FAILURE)); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(result); return; }
        if (char === '\u007f' || char === '\b') result = [...result].slice(0, -1).join('');
        else if (char >= ' ') result += char;
        if (result.length > 1024) { cleanup(); reject(new Error(FAILURE)); return; }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  insist(args.length === 5 && args[0] === '--synthetic-only' && args[1] === '--input' && args[3] === '--output');
  const password = await readPassword();
  const result = await recoverSynthetic({ input: args[2], output: args[4], password, syntheticOnly: true });
  process.stdout.write(`Recovered ${result.recovered} synthetic revisions; no files opened or executed.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write(FAILURE + '\nUsage: node recover.mjs --synthetic-only --input <CipherfoldStore> --output <new synthetic-recovery-NAME>\n'); process.exitCode = 1; });
}
