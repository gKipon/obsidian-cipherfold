import {parseHeaderJSON,unlockPasswordKey,makePasswordCredential,parsePasswordCredential,verifyPasswordCredential,ciphertextDigest,decryptReplicaMessage} from './crypto.mjs';
import {canonical,requireReplica as check} from './replica-model.mjs';
const filePattern=/^password-key-([1-9][0-9]*)-([0-9a-f]{64})\.rvkey$/;
export function passwordIO(raw,root){
  return {
    async read(){
      if(!await raw.exists(root))return null;
      const listing=await raw.list(root),items=[];
      for(const path of listing.files){const match=filePattern.exec(path.split('/').at(-1));if(!match)continue;
        check(items.length<256,'PASSWORD_HISTORY_LIMIT');const text=await raw.read(path),value=parsePasswordCredential(text);
        check(value.generation===Number(match[1])&&await ciphertextDigest(text)===match[2],'PASSWORD_LOCAL_INVALID');items.push(value);
      }
      items.sort((a,b)=>b.generation-a.generation);
      check(!items[1]||items[0].generation!==items[1].generation,'PASSWORD_LOCAL_CONFLICT');return items[0]??null;
    },
    async write(value){
      const text=JSON.stringify(value),digest=await ciphertextDigest(text),path=root+`/password-key-${value.generation}-${digest}.rvkey`;
      if(await raw.exists(path)){check(await raw.read(path)===text,'PASSWORD_LOCAL_INVALID');return;}
      const temp=root+'/password-key-'+crypto.randomUUID()+'.tmp';
      await raw.write(temp,text);check(await raw.read(temp)===text,'PASSWORD_READBACK');
      await raw.rename(temp,path);check(await raw.read(path)===text,'PASSWORD_READBACK');
    }
  };
}
// A new password wraps the same data key. The immutable legacy header remains
// the crypto context and a recovery copy: this is NOT compromised-key revocation.
export class PasswordManager{
  #queue=Promise.resolve();
  constructor({io,readHeader,readConfig,transportFactory,onAdopt=()=>{}}){Object.assign(this,{io,readHeader,readConfig,transportFactory,onAdopt});}
  #serial(fn){const p=this.#queue.then(fn);this.#queue=p.catch(()=>{});return p;}
  async unlock(header,password){return unlockPasswordKey(header,password,await this.io.read());}
  async #remote(header,key,transport){
    const id='rv-password:'+header.vaultId,doc=await transport.getDoc(id),local=await this.io.read();
    if(doc){check(doc.type==='rv-password'&&typeof doc.payload==='string','PASSWORD_REMOTE_INVALID');const remote=parsePasswordCredential(doc.payload);await verifyPasswordCredential(header,key,remote);
      check(!local||remote.generation>=local.generation,'PASSWORD_ROLLBACK');
      if(local&&remote.generation===local.generation)check(canonical(remote)===canonical(local),'PASSWORD_FORK');
      if(!local||remote.generation>local.generation){await this.io.write(remote);this.onAdopt(remote.generation);}
      return {id,doc,current:remote};
    }
    check(!local,'PASSWORD_REMOTE_MISSING');return {id,doc:null,current:null};
  }
  sync(header,key,transport){return this.#serial(()=>this.#remote(header,key,transport));}
  change(currentPassword,newPassword){return this.#serial(async()=>{
    const header=parseHeaderJSON(await this.readHeader()),local=await this.io.read();
    const key=await unlockPasswordKey(header,currentPassword,local);
    const savedConfig=await this.readConfig();
    // Only an absent enrollment permits a local rotation. A damaged/unreadable
    // enrollment must fail, never silently bypass remote generation checks.
    if(savedConfig===null){
      const next=await makePasswordCredential(header,local,currentPassword,newPassword);
      await verifyPasswordCredential(header,key,next);await this.io.write(next);
      await unlockPasswordKey(header,newPassword,await this.io.read());return next.generation;
    }
    const config=await decryptReplicaMessage(header,key,'config',savedConfig);
    check(config?.version===1&&['full','selective'].includes(config.mode),'PASSWORD_ENROLLMENT_REQUIRED');
    const transport=this.transportFactory(config.connection);await transport.connect();
    const {id,doc,current}=await this.#remote(header,key,transport);
    // A stale device first adopts the published password, and must then prove
    // knowledge of it. An offline old password cannot replace a newer password.
    check(canonical(current)===canonical(local),'PASSWORD_UPDATED_REOPEN');
    const next=await makePasswordCredential(header,local,currentPassword,newPassword);
    const actual=await transport.comparePassword(id,doc,next);
    check(actual?.type==='rv-password'&&canonical(parsePasswordCredential(actual.payload))===canonical(next),'PASSWORD_NOT_CONFIRMED');
    await verifyPasswordCredential(header,key,next);await this.io.write(next);
    await unlockPasswordKey(header,newPassword,await this.io.read());return next.generation;
  });}
}
