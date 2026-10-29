import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDedicatedVault} from '../src/onboarding.mjs';
import {createVault} from '../src/crypto.mjs';
const adapter=(files=[],folders=['.obsidian'],storeFiles=[],read=()=>{throw Error('unexpected read');})=>({list:async p=>p?{files:storeFiles,folders:[]}:{files,folders},exists:async p=>folders.includes(p),read,stat:async()=>({type:'file',size:10})});
test('preflight accepts only empty dedicated or valid Cipherfold vaults',async()=>{
 assert.equal(await assertDedicatedVault(adapter(),'.obsidian'),false);
 await assert.rejects(assertDedicatedVault(adapter(['private.md']),'.obsidian'),/DEDICATED/);
 await assert.rejects(assertDedicatedVault(adapter([],['.obsidian','Notes']),'.obsidian'),/DEDICATED/);
 await assert.rejects(assertDedicatedVault(adapter([],['.obsidian','CipherfoldStore'],['CipherfoldStore/plain.md']),'.obsidian'),/LAYOUT/);
 const {header}=await createVault('synthetic-long-password');
 const a=adapter([],['.obsidian','CipherfoldStore'],['CipherfoldStore/vault.rvkey'],async()=>JSON.stringify(header));
 assert.equal(await assertDedicatedVault(a,'.obsidian'),true);
 await assert.rejects(assertDedicatedVault({...a,read:async()=>JSON.stringify({...header,schema:'foreign/header/v1'})},'.obsidian'));
});
