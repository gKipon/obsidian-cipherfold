// Credentials must not follow a server-controlled redirect to another origin.
export async function requestReplica(options, fetchImpl=globalThis.fetch){
 const response=await fetchImpl(options.url,{method:options.method,headers:options.headers,body:options.body,redirect:'error',credentials:'omit',cache:'no-store'});
 return {status:response.status,text:await response.text()};
}
