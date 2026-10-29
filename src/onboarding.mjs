import {parseHeaderJSON,parseEnvelopeJSON} from './crypto.mjs';

// Check raw disk before changing any Obsidian adapter/cache hooks.
export async function assertDedicatedVault(raw, configDir) {
  const root = await raw.list('');
  const clean = value => value.replace(/^\//, '');
  if (root.files.length || root.folders.some(value => ![configDir, 'CipherfoldStore'].includes(clean(value)))) throw Error('DEDICATED_VAULT_REQUIRED');
  if (!await raw.exists('CipherfoldStore')) return false;
  const entries = await raw.list('CipherfoldStore');
  if (entries.folders.length || entries.files.length > 100001) throw Error('INVALID_STORE_LAYOUT');
  let initialized = false;
  for (const file of entries.files) {
    if (file === 'CipherfoldStore/vault.rvkey') {
      const stat = await raw.stat(file);
      if (!stat || stat.type !== 'file' || stat.size > 4096) throw Error('INVALID_HEADER_SIZE');
      parseHeaderJSON(await raw.read(file)); initialized = true;
    } else if (/^CipherfoldStore\/[0-9a-f-]{36}_[0-9a-f-]{36}\.renc$/.test(file)) {
      // Content is authenticated on unlock. Here reject arbitrary plaintext files.
      const stat = await raw.stat(file);
      if (!stat || stat.type !== 'file' || stat.size > 33 * 1024 * 1024) throw Error('INVALID_STORE_FILE');
      parseEnvelopeJSON(await raw.read(file));
    } else throw Error('INVALID_STORE_LAYOUT');
  }
  if (entries.files.length && !initialized) throw Error('MISSING_HEADER');
  return initialized;
}

export function setupModal(plugin, {Modal, Notice}) {
 return new class extends Modal {
  constructor(){super(plugin.app);}
  onOpen(){
   const c=this.contentEl;
   c.createEl('h2',{text:'Create an encrypted vault'});
   c.createEl('p',{text:'Use a new, dedicated Obsidian vault. Cipherfold stores encrypted revisions and projects notes into memory. Native File Recovery and metadata persistence are disabled in this vault. Keep encrypted backups; a lost password cannot be recovered.'});
   c.createEl('p',{text:'Use at least 12 characters. Disabling or upgrading this plugin requires a full Obsidian restart after saving and locking. Other plugins can read notes while unlocked.'});
   const inputs=['Passphrase','Repeat passphrase'].map(label=>{
    c.createEl('label',{text:label});return c.createEl('input',{type:'password',attr:{autocomplete:'new-password'}});
   });this.inputs=inputs;
   const status=c.createEl('p');const button=c.createEl('button',{text:'Create encrypted vault',cls:'mod-cta'});
   button.onclick=async()=>{
    if(button.disabled)return;
    let password=inputs[0].value;
    if([...password].length<12||password.length>1024||password!==inputs[1].value){status.setText('Passphrases must match and contain 12–1024 characters.');return;}
    button.disabled=true;inputs.forEach(i=>{i.value='';i.disabled=true;});
    try{
     await plugin.createVault(password);this.close();new Notice('Encrypted vault created. Create notes inside Native.');
    }catch{status.setText('Creation failed or was cancelled. Existing files were retained. Restart and verify before retrying.');button.disabled=false;}
    finally{password='';}
   };
  }
  onClose(){this.inputs?.forEach(i=>i.value='');this.contentEl.empty();}
 };
}
