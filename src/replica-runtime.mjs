import {requestReplica} from './network.mjs';
import {ReplicaEngine} from './replica-engine.mjs';
import {ReplicaTransport,connectionFromSettings} from './replica-transport.mjs';
import {recordPath} from './replica-model.mjs';
export async function installReplica(plugin,{Modal,Notice,requestUrl,codecFactory}){
  const root=plugin.app.vault.configDir+'/plugins/cipherfold',raw=plugin.raw;
  const io={unlockKey:(header,password)=>plugin.passwordManager.unlock(header,password),readPassword:()=>plugin.passwordIO.read(),syncPassword:(header,key,transport)=>plugin.passwordManager.sync(header,key,transport),readHeader:()=>raw.read('CipherfoldStore/vault.rvkey'),readConfig:async()=>await raw.exists(root+'/replica-config.json')?raw.read(root+'/replica-config.json'):null,
    writeConfig:text=>raw.write(root+'/replica-config.json',text),readState:async n=>await raw.exists(root+`/replica-state-${n}.json`)?raw.read(root+`/replica-state-${n}.json`):null,
    writeState:(n,text)=>raw.write(root+`/replica-state-${n}.json`,text),hasRecord:e=>raw.exists(recordPath(e)),readRecord:e=>raw.read(recordPath(e)),writeRecord:(e,text)=>raw.write(recordPath(e),text)};
  const transportFactory=settings=>new ReplicaTransport({settings,codecFactory,request:requestReplica});
  let publishProgress=null;
  const statusText={local:'local copy',syncing:'syncing',current:'server confirmed',retry:'pending upload / download',budget:'download limit too small',publishing:'initial archive verification',locked:'locked'};
  const engine=plugin.replica=new ReplicaEngine({io,transportFactory,onStatus:s=>{
    publishProgress?.(s);
    if(plugin.store.isUnlocked&&plugin.status)plugin.status.setText(`Cipherfold · ${statusText[s.state]||s.state}${s.pending?' · '+s.pending+' pending':''}${s.state==='publishing'?' '+(s.done||0)+'/'+s.total:''}${s.conflicts?' · conflicts: '+s.conflicts:''}`);
  }});
  let flight=null,queued=null,watchGeneration=0;
  const provider=()=>plugin.run(()=>plugin.store.replicaEntries());
  plugin.beforeReplicaUnlock=async password=>{
    if(!await io.readConfig())return;
    await engine.open(password);
    if(engine.mode==='selective'&&plugin.app.plugins.plugins['obsidian-livesync']){engine.lock();throw Error('SELECTIVE_LIVESYNC_FORBIDDEN');}
  };
  plugin.syncReplica=({quiet=false}={})=>{
    if(!engine.unlocked||!plugin.store.isUnlocked||plugin.lockPromise)return Promise.resolve();
    if(flight){if(!queued)queued=flight.then(()=>{queued=null;return plugin.syncReplica({quiet});});return queued;}
    flight=(async()=>{
      try{
        const plan=await engine.sync(provider);
        if(engine.unlocked&&plugin.store.isUnlocked)await plugin.run(async()=>{plugin.store.setReplicaCatalogue(engine.entries);await plugin.store.refresh();await plugin.publish();});
        if(plan&&!plan.withinBudget&&engine.mode==='selective')new Notice(`Cipherfold: download of ${(plan.downloadBytes/1048576).toFixed(1)} MiB exceeds the limit. Change it in Selective replica settings.`);
      }catch{
        // Downloaded immutable files are safe even if the later network request
        // failed. Keep prior local notes editable; the red status is not an ACK.
        if(engine.unlocked&&plugin.store.isUnlocked){
          try{await plugin.run(async()=>{plugin.store.setReplicaCatalogue(engine.entries);await plugin.store.refresh();await plugin.publish();});}catch{}
          if(!quiet)new Notice('Cipherfold: sync incomplete. Local changes retained; retry when connected.');
        }
      }
    })().finally(()=>{flight=null;});return flight;
  };
  plugin.watchReplica=()=>{
    const generation=++watchGeneration;
    void(async()=>{let since=engine.lastSequence??'0';while(generation===watchGeneration&&engine.unlocked){
      try{const changes=await engine.transport.changes(since);if(generation!==watchGeneration||!engine.unlocked)return;since=changes.last_seq;if(changes.results?.length)await plugin.syncReplica({quiet:true});}catch{return;}
    }})();
  };
  plugin.closeReplica=()=>{watchGeneration++;engine.lock();};
  class ArchiveModal extends Modal{
    onOpen(){
      this.contentEl.addClass('cipherfold-replica-modal');
      this.contentEl.createEl('h2',{text:'Server archive'});
      this.contentEl.createEl('p',{text:'Search titles. Obsidian full-text search covers downloaded notes only.'});
      const input=this.contentEl.createEl('input',{type:'search',placeholder:'Note title'}),list=this.contentEl.createDiv();
      const render=()=>{list.empty();const entries=engine.archive().filter(e=>e.name.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())).slice(0,100);
        for(const e of entries){const row=list.createDiv();row.createEl('span',{text:e.name.replace(/^Native\//,'')+' · '+e.updatedAt.slice(0,10)+' '});const button=row.createEl('button',{text:plugin.store.listFiles().some(f=>f.objectId===e.objectId)?'Open':'Download'});
          button.onclick=async()=>{button.disabled=true;try{await engine.pin(e.objectId);await plugin.syncReplica();const file=plugin.store.listFiles().find(f=>f.objectId===e.objectId);if(file){this.close();await plugin.app.workspace.getLeaf('tab').openFile(plugin.app.vault.getFileByPath(file.path));}else new Notice('Cipherfold: note is not ready or has conflicting revisions.');}finally{button.disabled=false;}};}
      };input.oninput=render;render();
    }
    onClose(){this.contentEl.empty();}
  }
  class ReplicaSettings extends Modal{
    onOpen(){
      this.contentEl.addClass('cipherfold-replica-modal');
      this.contentEl.createEl('h2',{text:'Selective replica'});
      this.contentEl.createEl('p',{text:'Recently changed notes and their attachments download automatically. Downloaded files are retained; older notes are available through the archive.'});
      this.contentEl.createEl('label',{text:'Window, months (1–120)'});const months=this.contentEl.createEl('input',{type:'number'});months.value=String(engine.config.months);
      this.contentEl.createEl('label',{text:'Download limit, MiB (1–1024)'});const limit=this.contentEl.createEl('input',{type:'number'});limit.value=String(engine.config.maxDownloadBytes/1048576);
      this.contentEl.createEl('button',{text:'Apply and download'}).onclick=async()=>{try{await engine.setWindow(Number(months.value),Math.floor(Number(limit.value)*1048576));this.close();await plugin.syncReplica();}catch{new Notice('Cipherfold: check the window and download limit.');}};
    }
    onClose(){this.contentEl.empty();}
  }
  class ConflictsModal extends Modal{
    onOpen(){
      this.contentEl.addClass('cipherfold-replica-modal');
      this.contentEl.createEl('h2',{text:'Resolve revisions'});const groups=new Map();for(const r of plugin.store.conflicts()){const list=groups.get(r.objectId)||[];list.push(r);groups.set(r.objectId,list);}
      if(!groups.size){this.contentEl.createEl('p',{text:'No conflicts.'});return;}
      for(const [objectId,records]of groups){
        if(records.some(r=>!r.available)){this.contentEl.createEl('p',{text:records[0].name+': conflicting revisions have not finished downloading. Retry sync when connected.'});continue;}
        if(records.some(r=>r.kind!=='note')){this.contentEl.createEl('p',{text:'Notebook or attachment conflict requires separate recovery; both versions retained.'});continue;}
        const box=this.contentEl.createDiv();box.createEl('h3',{text:records[0].name});
        for(const r of records){box.createEl('p',{text:r.name+' · '+r.updatedAt+(r.deleted?' · trashed':'' )});const source=box.createEl('textarea');source.value=plugin.store.readRevision(objectId,r.revisionId);source.readOnly=true;}
        box.createEl('label',{text:'Resulting note name'});const name=box.createEl('input');name.value=records[0].name;
        box.createEl('label',{text:'Merged text — review before saving'});const body=box.createEl('textarea');body.value=plugin.store.readRevision(objectId,records[0].revisionId);
        box.createEl('button',{text:'Save resolved revision'}).onclick=async()=>{
          try{
            // Never replace an editor draft while resolving from a separate modal.
            if(records.some(r=>plugin.editorViews(r.name).some(v=>{const b=plugin.editorBaselines.get(v);return !b||v.getViewData()!==b.body;})))throw Error('UNSAVED_DRAFT');
            await plugin.run(async()=>{await plugin.store.resolve(objectId,records.map(r=>r.revisionId),name.value,body.value);await plugin.publish();});this.close();await plugin.syncReplica();
          }catch{new Notice('Cipherfold: revisions or open drafts changed. Save the draft and reopen conflict resolution.');}
        };
      }
    }
    onClose(){this.contentEl.empty();}
  }
  class TrashModal extends Modal{
    onOpen(){
      this.contentEl.createEl('h2',{text:'Encrypted trash'});
      this.contentEl.createEl('p',{text:'Deleted notes can be restored. History and attachments are retained. A number is appended if the former name is occupied.'});
      const entries=engine.unlocked?engine.archive({deleted:true}):plugin.store.deletedNotes();
      if(!entries.length)this.contentEl.createEl('p',{text:'Trash is empty.'});
      for(const e of entries){
        const row=this.contentEl.createDiv();row.createEl('span',{text:e.name.replace(/^Native\//,'')+' '});
        const button=row.createEl('button',{text:'Restore'});
        button.onclick=async()=>{button.disabled=true;try{
          if(engine.unlocked){await engine.pin(e.objectId);await plugin.syncReplica();}
          const path=plugin.app.vault.getAvailablePath(e.name.replace(/\.md$/i,''),'md');
          await plugin.run(async()=>{plugin.validateSync();await plugin.store.restore(e.objectId,e.revisionId,path);await plugin.publish();});
          this.close();await plugin.syncReplica();
          const file=plugin.app.vault.getFileByPath(path);if(file)await plugin.app.workspace.getLeaf('tab').openFile(file);
        }catch{new Notice('Cipherfold: restore failed. Check connectivity and conflicts; history retained.');button.disabled=false;}};
      }
    }
    onClose(){this.contentEl.empty();}
  }
  class NotebookModal extends Modal{
    onOpen(){
      this.contentEl.createEl('h2',{text:'Create notebook'});
      const input=this.contentEl.createEl('input',{type:'text',placeholder:'Notebook name'});
      const button=this.contentEl.createEl('button',{text:'Create'});
      button.onclick=async()=>{button.disabled=true;try{
        const name=input.value.trim();if(!name||/[\/\\]/.test(name)||name==='.'||name==='..')throw Error('INVALID_PATH');
        const path='Native/'+name;if(plugin.store.stat(path))throw Error('STORE_CONFLICT');
        await plugin.adapter.mkdir(path);plugin.noteWorkflow.folder=path;this.close();new Notice('Cipherfold: notebook created. New notes will be created inside it.');
      }catch{new Notice('Cipherfold: notebook creation failed. Check the name and duplicates.');button.disabled=false;}};
      input.focus();
    }
    onClose(){this.contentEl.empty();}
  }
  class PublishModal extends Modal{
    onOpen(){
      this.contentEl.addClass('cipherfold-replica-modal');
      this.contentEl.createEl('h2',{text:'Prepare selective replicas'});
      this.contentEl.createEl('p',{text:'One-time preparation of the server catalog for new devices. It verifies the whole archive over the network and takes longer than a normal unlock. Later sync transfers changes. Keep the vault unlocked until complete.'});
      const progress=this.contentEl.createEl('p',{text:'Ready to prepare.'});
      this.progress=s=>{if(s.state==='publishing')progress.setText(`Verified server records: ${s.done||0} of ${s.total}.`);};publishProgress=this.progress;
      const input=this.contentEl.createEl('input',{type:'password',placeholder:'Vault password'});input.autocomplete='off';
      const button=this.contentEl.createEl('button',{text:'Prepare'});button.onclick=async()=>{
        const password=input.value;input.value='';button.disabled=true;progress.setText('Unlocking key and connecting to server…');
        try{await engine.bootstrap(password,connectionFromSettings(plugin.app.plugins.plugins['obsidian-livesync']?.core?.settings),provider);await exportEnrollment();this.close();await plugin.syncReplica();plugin.watchReplica();}
        catch{progress.setText('Preparation incomplete. History retained.');new Notice('Cipherfold: preparation incomplete. History retained; retry with vault unlocked and server reachable.');button.disabled=false;}
      };
    }
    onClose(){if(publishProgress===this.progress)publishProgress=null;this.contentEl.empty();}
  }
  const exportEnrollment=async()=>{
    const kit=await engine.enrollment();await raw.write(root+'/device-enrollment.rvsetup',JSON.stringify(kit));
    new Notice('Cipherfold: encrypted enrollment kit saved in the plugin folder. See docs/SYNC.md before transferring it to a new dedicated vault.');
  };
  const ready=callback=>()=>{if(!plugin.store.isUnlocked){new Notice('Unlock encrypted notes first.');return;}callback();};
  plugin.addCommand({id:'selective-prepare',name:'Prepare selective replicas',callback:ready(()=>engine.preparing?new Notice('Cipherfold: catalog preparation already in progress.'):engine.unlocked?void exportEnrollment():new PublishModal(plugin.app).open())});
  plugin.addCommand({id:'selective-sync',name:'Sync changes with server',callback:ready(()=>void plugin.syncReplica())});
  plugin.addCommand({id:'selective-archive',name:'Find and download a note from archive',callback:ready(()=>engine.unlocked?new ArchiveModal(plugin.app).open():new Notice('Prepare selective replicas first.'))});
  plugin.addCommand({id:'selective-settings',name:'Selective replica: window and limit',callback:ready(()=>engine.unlocked?new ReplicaSettings(plugin.app).open():new Notice('Prepare selective replicas first.'))});
  plugin.addCommand({id:'resolve-conflicts',name:'Resolve conflicting revisions',callback:ready(()=>new ConflictsModal(plugin.app).open())});
  plugin.addCommand({id:'create-notebook',name:'Create notebook',callback:ready(()=>new NotebookModal(plugin.app).open())});
  plugin.addCommand({id:'trash',name:'Trash: restore a note',callback:ready(()=>new TrashModal(plugin.app).open())});
}
