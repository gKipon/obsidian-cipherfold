import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReplicaTransport} from '../src/replica-transport.mjs';
import {ciphertextDigest} from '../src/crypto.mjs';
const settings={encrypt:true,encryptInternalMetadata:true,E2EEAlgorithm:'v2',enableCompression:false,useEden:false,usePathObfuscation:true,idDerivationVersion:1,idDerivationKey:'a'.repeat(64),couchDB_URI:'https://example.invalid/sync',couchDB_DBNAME:'synthetic',couchDB_USER:'synthetic',couchDB_PASSWORD:'synthetic',passphrase:'synthetic'};
async function fixture(){
  const path='CipherfoldStore/'+crypto.randomUUID()+'_'+crypto.randomUUID()+'.renc';
  const children=Array.from({length:70},(_,i)=>'h:'+i%35),docs=new Map(),requests=[];
  for(const child of children)docs.set(child,{_id:child,type:'leaf',data:child+';'});
  const value=children.map(id=>docs.get(id).data).join('');
  docs.set(path,{_id:path,path,type:'newnote',children,size:Buffer.byteLength(value),eden:{}});
  const expected={ciphertextBytes:Buffer.byteLength(value),sha256:await ciphertextDigest(value)};
  const transport=new ReplicaTransport({settings,codecFactory:async()=>{},request:async args=>{
    requests.push(args);assert.equal(args.method,'POST');assert(args.url.endsWith('/_all_docs?include_docs=true&conflicts=true'));
    const {keys}=JSON.parse(args.body);assert(keys.length<=32);
    return {status:200,text:JSON.stringify({rows:keys.map(key=>docs.has(key)?{key,id:key,doc:docs.get(key)}:{key,error:'not_found'})})};
  }});
  transport.codec={pathId:async p=>p,decode:async d=>d,content:m=>m.data.join('')};
  return {transport,path,expected,value,docs,requests};
}
test('batched read preserves chunk order and duplicates across 32-key boundaries',async()=>{
  const f=await fixture();assert.equal(await f.transport.readFile(f.path,f.expected),f.value);
  assert.equal(f.requests.length,4);assert.equal(f.transport.stats.downloadedRecords,1);
});
test('existing file is fully verified with one metadata fetch and no append',async()=>{
  const f=await fixture();await f.transport.writeFile(f.path,f.value,f.expected);assert.equal(f.requests.length,4);
  f.docs.get('h:0').data='bad';await assert.rejects(f.transport.writeFile(f.path,f.value,f.expected));
  assert.equal(f.transport.stats.downloadedRecords,1);
});
test('missing, conflicting and substituted batch documents fail closed',async()=>{
  for(const fault of ['missing','conflict','id','order','length']){
    const f=await fixture();
    if(fault==='missing')f.docs.delete('h:3');
    if(fault==='conflict')f.docs.get('h:3')._conflicts=['2-bad'];
    if(fault==='id')f.docs.get('h:3')._id='h:other';
    if(fault==='order'||fault==='length'){
      const request=f.transport.request;f.transport.request=async args=>{
        const response=await request(args),body=JSON.parse(response.text);
        if(body.rows.length>1){if(fault==='order')body.rows.reverse();else body.rows.pop();}
        return {...response,text:JSON.stringify(body)};
      };
    }
    await assert.rejects(f.transport.readFile(f.path,f.expected));assert.equal(f.transport.stats.downloadedRecords,0);
  }
});
test('bounded reads reject oversized batches and unrelated POST endpoints',async()=>{
  const f=await fixture();await assert.rejects(f.transport.getDocs(Array(33).fill('h:x')));
  await assert.rejects(f.transport.json('/_find',{method:'POST',body:{}}));assert.equal(f.requests.length,0);
});

async function conflictedFixture(fault){
  const f=await fixture(),id='h:3',winner='1-'+'a'.repeat(32),other='1-'+'b'.repeat(32);
  const original={...f.docs.get(id),_rev:winner};
  f.docs.set(id,{...original,_conflicts:[other]});
  const alternate={...original,_rev:other};
  if(fault==='different')alternate.data+='DIFFERENT';
  if(fault==='id')alternate._id='h:substitute';
  if(fault==='deleted')alternate._deleted=true;
  if(fault==='type')alternate.type='newnote';
  if(fault==='field')alternate.extra='unmatched';
  if(fault==='duplicate')alternate._rev=winner;
  if(fault==='limit')f.docs.get(id)._conflicts=Array.from({length:8},(_,i)=>'1-'+String(i).padStart(32,'0'));
  if(fault==='metadata')f.docs.get(f.path)._conflicts=[other];
  const request=f.transport.request;
  f.transport.request=async args=>{
    if(args.url.endsWith('/_bulk_get')){
      f.requests.push(args);assert.equal(args.method,'POST');
      assert.deepEqual(JSON.parse(args.body),{docs:[{id,rev:winner},{id,rev:other}]});
      const docs=fault==='missing'?[{ok:original}]:[{ok:alternate},{ok:original}];
      return {status:200,text:JSON.stringify({results:[{id,docs}]})};
    }
    if(args.url.endsWith('/_bulk_docs')){f.requests.push(args);return {status:201,text:JSON.stringify([{id,error:'conflict'}])};}
    return request(args);
  };
  if(fault==='auth')f.transport.codec.decode=async doc=>{if(doc._rev===other)throw Error('Authentication failed');return doc;};
  return {...f,id,original};
}
test('identical authenticated leaf branches are read without deleting or changing history',async()=>{
  const f=await conflictedFixture(),before=structuredClone(f.docs);
  assert.equal(await f.transport.readFile(f.path,f.expected),f.value);
  assert.deepEqual(f.docs,before);assert(f.requests.some(r=>r.url.endsWith('/_bulk_get')));
  assert(f.requests.every(r=>!r.url.endsWith('/_bulk_docs')));
});
test('different, unauthenticated, missing or substituted leaf branches fail closed',async()=>{
  for(const fault of ['different','auth','missing','id','deleted','type','field','duplicate','limit','metadata']){
    const f=await conflictedFixture(fault);
    await assert.rejects(f.transport.readFile(f.path,f.expected));
    assert.equal(f.transport.stats.downloadedRecords,0);
  }
});
test('default document and password reads still reject even identical conflicts',async()=>{
  const f=await conflictedFixture();await assert.rejects(f.transport.getDoc(f.id));
  assert(f.requests.every(r=>!r.url.endsWith('/_bulk_get')));
});
test('existing chunk append authenticates equivalent competing revisions',async()=>{
  const f=await conflictedFixture();const doc=await f.transport.appendDoc(f.id,{_id:f.id,type:'leaf',data:f.original.data});
  assert.equal(doc.data,f.original.data);assert(f.requests.some(r=>r.url.endsWith('/_bulk_get')));
});
test('matching conflict branches do not bypass the expected file digest',async()=>{
  const f=await conflictedFixture();await assert.rejects(f.transport.readFile(f.path,{...f.expected,sha256:'0'.repeat(64)}));
  assert.equal(f.transport.stats.downloadedRecords,0);
});
