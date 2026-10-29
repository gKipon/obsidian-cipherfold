// Permit only the existing Obsidian desktop OS-encrypted SecretStorage slot.
// All workspace/metadata storage remains volatile. No new encryption format.
export function isEncryptedSecretSlot(app,key,value){
  if(key!=='secrets-encrypted')return false;
  const adapter=app.secretStorage?.adapter;
  if(typeof adapter?.isEncryptionAvailable!=='function'||adapter.isEncryptionAvailable()!==true)return false;
  if(value===null||value===undefined)return true;
  if(typeof value!=='string'||value.length>262144||!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
  try{
    const decoded=adapter.decrypt(value);
    if(decoded===value)return false;
    const secrets=JSON.parse(decoded);
    return secrets!==null&&typeof secrets==='object'&&!Array.isArray(secrets)&&
      Object.entries(secrets).every(([k,v])=>k.length<=256&&typeof v==='string'&&v.length<=65536);
  }catch{return false;}
}
