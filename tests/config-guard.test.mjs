import test from 'node:test';
import assert from 'node:assert/strict';
import {isPluginEnablement} from '../src/config-guard.mjs';
const app={plugins:{manifests:{cipherfold:{},'dictation-bridge':{}}}};
test('activation persistence accepts only unique installed plugin IDs',()=>{
  for(const value of [[],['cipherfold'],['dictation-bridge','cipherfold']])assert(isPluginEnablement(app,JSON.stringify(value)));
  for(const value of [null,{},['unknown'],['cipherfold','cipherfold'],[{title:'synthetic note'}],['Native/Note.md'],['__proto__']])assert.equal(isPluginEnablement(app,JSON.stringify(value)),false);
  assert.equal(isPluginEnablement(app,'not JSON'),false);assert.equal(isPluginEnablement(app,' '.repeat(65537)),false);
});
