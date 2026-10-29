import {readBoundedText} from './http-body.mjs';
// Credentials must not follow a server-controlled redirect to another origin.
export async function requestReplica(options, fetchImpl=globalThis.fetch,timeoutMs=90000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(options.url,{method:options.method,headers:options.headers,body:options.body,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
  return {status:response.status,text:await readBoundedText(response,48*1024*1024)};
 }finally{clearTimeout(timer);controller.abort();}
}
