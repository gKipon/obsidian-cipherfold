import {test} from 'node:test';import assert from 'node:assert/strict';import {installReplica} from '../src/replica-runtime.mjs';
test('an on-demand request during background sync awaits its own follow-up hydration',async()=>{
 const plugin={app:{vault:{configDir:'.obsidian'},plugins:{plugins:{}}},raw:{exists:async()=>false},store:{isUnlocked:true,replicaEntries:async()=>[],setReplicaCatalogue(){},refresh:async()=>{}},addCommand(){},run:f=>f(),publish:async()=>{}};
 await installReplica(plugin,{Modal:class{},Notice:class{},requestUrl:()=>{},codecFactory:()=>{}});
 Object.defineProperty(plugin.replica,'unlocked',{get:()=>true});const gates=[];
 plugin.replica.sync=()=>new Promise(resolve=>gates.push(()=>resolve({withinBudget:true})));
 const first=plugin.syncReplica(),requested=plugin.syncReplica();let ready=false;requested.then(()=>{ready=true;});assert.equal(gates.length,1);
 gates[0]();await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(gates.length,2);assert.equal(ready,false);
 gates[1]();await requested;assert.equal(ready,true);
});
