import test from 'node:test';
import assert from 'node:assert/strict';
import {isEncryptedSecretSlot} from '../src/secret-storage-guard.mjs';
const app={secretStorage:{adapter:{isEncryptionAvailable:()=>true,decrypt:value=>{if(value==='Y2lwaGVy')return JSON.stringify({'dictation-bridge-openai':'fixture'});throw Error('decrypt failed');}}}};
test('only actual decryptable OS-encrypted secret slot is durable',()=>{
 assert.equal(isEncryptedSecretSlot(app,'secrets-encrypted','Y2lwaGVy'),true);
 for(const key of ['workspace','recent-files','secrets','secrets-meta'])assert.equal(isEncryptedSecretSlot(app,key,'Y2lwaGVy'),false);
 for(const value of ['plaintext note','{"secret":"key"}','YmFk',{},''])assert.equal(isEncryptedSecretSlot(app,'secrets-encrypted',value),false);
 assert.equal(isEncryptedSecretSlot(app,'secrets-encrypted',null),true);
});
test('missing or unavailable OS encryption never permits persistence',()=>{
 assert.equal(isEncryptedSecretSlot({},'secrets-encrypted','Y2lwaGVy'),false);
 const unavailable={secretStorage:{adapter:{...app.secretStorage.adapter,isEncryptionAvailable:()=>false}}};assert.equal(isEncryptedSecretSlot(unavailable,'secrets-encrypted',null),false);
 const identity={secretStorage:{adapter:{isEncryptionAvailable:()=>true,decrypt:v=>v}}};assert.equal(isEncryptedSecretSlot(identity,'secrets-encrypted','Y2lwaGVy'),false);
});
