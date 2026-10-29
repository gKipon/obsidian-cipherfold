// Bound decoded response bytes while streaming, before allocating a full string.
export async function readBoundedText(response,limit){
 const fail=()=>Object.assign(new Error('RESPONSE_LIMIT'),{code:'RESPONSE_LIMIT'});
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel().catch(()=>{});throw fail();}
 if(!response.body)return '';
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let size=0,text='';
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>limit)throw fail();
   text+=decoder.decode(value,{stream:true});
  }
  return text+decoder.decode();
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
}
