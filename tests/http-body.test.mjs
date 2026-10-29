import test from 'node:test';
import assert from 'node:assert/strict';
import {readBoundedText} from '../src/http-body.mjs';
test('bounded reader preserves split multibyte UTF-8 and exact byte limit',async()=>{
 const bytes=new TextEncoder().encode('hello 🔐');
 const stream=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
 assert.equal(await readBoundedText(new Response(stream),bytes.length),'hello 🔐');
});
test('oversized Content-Length cancels without consuming a body',async()=>{
 let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}});
 await assert.rejects(readBoundedText(new Response(body,{headers:{'Content-Length':'5000'}}),10),{code:'RESPONSE_LIMIT'});
 assert.equal(cancelled,true);
});
test('missing or misleading Content-Length cannot bypass streaming limit',async()=>{
 for(const headers of [{},{'Content-Length':'1'}]){
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){cancelled=true;}});
  await assert.rejects(readBoundedText(new Response(body,{headers}),10),{code:'RESPONSE_LIMIT'});
  assert.equal(cancelled,true);assert.equal(body.locked,false);
 }
});
test('invalid UTF-8 is rejected and body lock released',async()=>{
 const response=new Response(Uint8Array.of(0xff));
 await assert.rejects(readBoundedText(response,10),TypeError);assert.equal(response.body.locked,false);
});
