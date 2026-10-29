import {requestReplica} from './network.mjs';
import {PasswordManager,passwordIO} from './password-manager.mjs';
import {ReplicaTransport} from './replica-transport.mjs';
import {LIMITS} from './crypto.mjs';
export function installPassword(plugin,{Modal,Notice,requestUrl,codecFactory}){
  const root=plugin.app.vault.configDir+'/plugins/cipherfold',raw=plugin.raw;
  const io=passwordIO(raw,root),manager=new PasswordManager({io,readHeader:()=>raw.read('CipherfoldStore/vault.rvkey'),readConfig:async()=>await raw.exists(root+'/replica-config.json')?raw.read(root+'/replica-config.json'):null,
    transportFactory:settings=>new ReplicaTransport({settings,codecFactory,request:requestReplica}),
    onAdopt:()=>new Notice('Cipherfold: received a new access password. Use it at the next unlock.')});
  plugin.passwordManager=manager;plugin.passwordIO=io;
  let busy=false;
  class PasswordModal extends Modal{
    onOpen(){
      const el=this.contentEl;el.createEl('h2',{text:'Change access password'});
      el.createEl('p',{text:'Local vaults change the password on this device. Enrolled replicas also require a reachable server. This changes the wrapping password, not the data key. Old setup kits, key headers and backups still open with the old password. This does not revoke a compromised key.'});
      el.createEl('p',{text:'Use a long, unique passphrase. Short passwords and PINs can be brute-forced offline by anyone holding a copy of your encrypted files.'});
      el.createEl('p',{text:'Other devices receive the change during sync. An offline device may need its old password for the first sync; then lock and use the new password.'});
      const inputs=['Current password',`New password — at least ${12} characters`,'Repeat new password'].map(label=>{el.createEl('label',{text:label});return el.createEl('input',{type:'password',attr:{autocomplete:'off',spellcheck:'false'}});});
      this.inputs=inputs;const status=el.createEl('p'),button=el.createEl('button',{text:'Change password',cls:'mod-cta'});
      button.onclick=async()=>{
        if(busy)return;let [oldPassword,newPassword,repeat]=inputs.map(i=>i.value);
        if([...newPassword].length<12||newPassword.length>LIMITS.passwordMax||newPassword!==repeat||oldPassword===newPassword){status.textContent=`Passwords must match; the new password must differ from the old one and contain ${12}–${LIMITS.passwordMax} characters.`;return;}
        busy=true;button.disabled=true;inputs.forEach(i=>{i.value='';i.disabled=true;});repeat='';status.textContent='Saving edits and checking password…';
        try{
          if(!await plugin.lock())throw Error('LOCK_FAILED');
          if(plugin.disposed)throw Error('DISPOSED');
          const generation=await manager.change(oldPassword,newPassword);
          status.textContent=`Password change verified (generation ${generation}). Unlock with the new password. Enrolled replicas must sync other devices.`;
          new Notice('Cipherfold: access password changed.');
        }catch(error){
          status.textContent=error.code==='PASSWORD_UPDATED_REOPEN'?'A newer password was received from the server. Retry with the current password.':'Unable to confirm password change. Check connectivity and the current password. After interruption, unlock with the old password and sync to receive the server-confirmed change. If already received, use the new password.';
          button.disabled=false;inputs.forEach(i=>{i.disabled=false;});
        }finally{oldPassword='';newPassword='';busy=false;}
      };
    }
    onClose(){this.inputs?.forEach(i=>{i.value='';});this.contentEl.empty();}
  }
  plugin.addCommand({id:'change-password',name:'Change access password',callback:()=>{if(busy){new Notice('Cipherfold: a password change is already in progress.');return;}new PasswordModal(plugin.app).open();}});
  return manager;
}
