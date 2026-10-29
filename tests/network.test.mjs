import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestReplica} from '../src/network.mjs';
test('replica credentials never follow an HTTP redirect',async()=>{
 let hits=0;const server=http.createServer((req,res)=>{if(req.url==='/other'){hits++;res.end('{}');}else{res.writeHead(307,{Location:'/other'});res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(requestReplica({url:`http://127.0.0.1:${server.address().port}/original`,method:'POST',headers:{Authorization:'Basic synthetic'},body:'{}'}));assert.equal(hits,0);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
