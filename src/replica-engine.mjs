import {parseHeaderJSON,parseEnvelopeJSON,unlockVault,decryptRecord,ciphertextDigest,encryptReplicaMessage,decryptReplicaMessage,validateReplicaEntries} from './crypto.mjs';
import {planSelectiveReplica} from './selective-policy.mjs';
import {canonical,descriptor,mergeEntries,heads,recordPath,requireReplica as check} from './replica-model.mjs';
const BASE=/^rv-catalog:[0-9a-f-]{36}$/;
const REV=/^rv-revision:[0-9a-f-]{36}$/;
const withoutDependencies=e=>{const {attachments,...value}=e;return value;};
/** Encrypted checkpoints are acceleration, never the sole copy of an edit.
 * Every local immutable .renc file is rediscovered as an outbox item on restart.
 * Two alternating authenticated slots tolerate a torn latest checkpoint. */
export class ReplicaEngine {
  #key=null;#header=null;#generation=0;#queue=Promise.resolve();#sequence=0;#enrolled=false;#preparing=false;
  constructor({io,transportFactory,clock=()=>new Date().toISOString(),onStatus=()=>{},onChange=()=>{}}){
    this.io=io;this.transportFactory=transportFactory;this.clock=clock;this.onStatus=onStatus;this.onChange=onChange;
    this.entries=[];this.confirmed=new Set();this.pins=new Set();this.status={state:'locked',pending:0};
  }
  get unlocked(){return !!this.#key&&this.#enrolled;}
  get preparing(){return this.#preparing;}
  get mode(){return this.config?.mode;}
  #session(){check(this.unlocked,'REPLICA_LOCKED');return this.#generation;}
  #assert(g){check(this.#key&&g===this.#generation,'REPLICA_LOCKED');}
  #status(state,extra={}){this.status={...this.status,state,...extra};try{this.onStatus(this.status);}catch{}}
  #serial(fn){const p=this.#queue.then(fn);this.#queue=p.catch(()=>{});return p;}
  lock(){this.#generation++;this.#key=null;this.#header=null;this.#enrolled=false;this.transport=null;this.config=null;this.lastSequence=null;this.entries=[];this.confirmed.clear();this.pins.clear();this.#status('locked');}
  async open(password){
    this.lock();const g=this.#generation;
    const header=parseHeaderJSON(await this.io.readHeader()),key=await (this.io.unlockKey??unlockVault)(header,password);
    check(g===this.#generation,'REPLICA_LOCKED');this.#header=header;this.#key=key;
    try{
      this.config=await decryptReplicaMessage(header,key,'config',await this.io.readConfig());this.#assert(g);
      check(this.config?.version===1&&['full','selective'].includes(this.config.mode)&&BASE.test(this.config.baseId));
      check(Number.isInteger(this.config.months)&&this.config.months>=1&&this.config.months<=120);
      check(Number.isSafeInteger(this.config.maxDownloadBytes)&&this.config.maxDownloadBytes>=0&&this.config.maxDownloadBytes<=1024*1024*1024);
      this.transport=this.transportFactory(this.config.connection);
      const candidates=[];let found=0;
      for(let slot=0;slot<2;slot++){
        const raw=await this.io.readState(slot);this.#assert(g);if(!raw)continue;found++;
        try{const state=await decryptReplicaMessage(header,key,'state',raw);this.#assert(g);this.#validateState(state);candidates.push(state);}catch(e){if(e.code==='REPLICA_LOCKED')throw e;}
      }
      check(!found||candidates.length,'STATE_CORRUPT');
      const state=candidates.sort((a,b)=>b.sequence-a.sequence)[0];
      this.#sequence=state?.sequence??0;this.entries=state?.entries??[];this.confirmed=new Set(state?.confirmed??[]);this.pins=new Set(state?.pins??[]);
      this.#enrolled=true;this.#status('local');return this.config.mode;
    }catch(e){this.lock();throw e;}
  }
  #validateState(s){
    check(s?.version===1&&s.baseId===this.config.baseId&&Number.isSafeInteger(s.sequence)&&s.sequence>0);
    validateReplicaEntries(s.entries);check(Array.isArray(s.confirmed)&&s.confirmed.length<=60000&&Array.isArray(s.pins)&&s.pins.length<=60000);
    const revisions=new Set(s.entries.map(e=>e.revisionId)),objects=new Set(s.entries.filter(e=>e.kind==='note').map(e=>e.objectId));
    check(s.confirmed.every(id=>revisions.has(id))&&s.pins.every(id=>objects.has(id)));
  }
  async #persist(g){
    this.#assert(g);const sequence=this.#sequence+1;
    const value={version:1,baseId:this.config.baseId,sequence,entries:this.entries,confirmed:[...this.confirmed].sort(),pins:[...this.pins].sort()};
    this.#validateState(value);
    const raw=await encryptReplicaMessage(this.#header,this.#key,'state',value);this.#assert(g);
    await this.io.writeState(sequence%2,raw);this.#assert(g);
    const readback=await decryptReplicaMessage(this.#header,this.#key,'state',await this.io.readState(sequence%2));this.#assert(g);
    check(canonical(readback)===canonical(value),'STATE_READBACK');this.#sequence=sequence;
  }
  async #decodeDoc(doc,id){
    check(doc&&doc._id===id&&doc.type==='rv-selective'&&typeof doc.payload==='string'&&!doc._conflicts?.length);
    const entries=validateReplicaEntries(await decryptReplicaMessage(this.#header,this.#key,id,doc.payload));
    if(REV.test(id))check(entries.length===1&&id==='rv-revision:'+entries[0].revisionId);
    else check(BASE.test(id));return entries;
  }
  async #append(id,entries,g){
    const existing=await this.transport.getDoc(id);this.#assert(g);
    if(existing){check(canonical(await this.#decodeDoc(existing,id))===canonical(entries),'CATALOGUE_EQUIVOCATION');return;}
    const payload=await encryptReplicaMessage(this.#header,this.#key,id,entries);this.#assert(g);
    const actual=await this.transport.appendDoc(id,{_id:id,type:'rv-selective',payload});this.#assert(g);
    check(canonical(await this.#decodeDoc(actual,id))===canonical(entries),'CATALOGUE_READBACK');this.#assert(g);
  }
  async #catalogue(g){
    const base=await this.#decodeDoc(await this.transport.getDoc(this.config.baseId),this.config.baseId);this.#assert(g);
    const documents=await this.transport.listCatalog();this.#assert(g);
    const incoming=[];
    for(const doc of documents){check(REV.test(doc._id));incoming.push(...await this.#decodeDoc(doc,doc._id));this.#assert(g);}
    this.entries=mergeEntries(this.entries,base,incoming);
  }
  #mergeLocal(local){
    validateReplicaEntries(local);const known=new Map(this.entries.map(e=>[e.revisionId,e]));
    for(const e of local){const previous=known.get(e.revisionId);if(previous)check(canonical(withoutDependencies(previous))===canonical(withoutDependencies(e)),'LOCAL_RECORD_CHANGED');else known.set(e.revisionId,e);}
    this.entries=mergeEntries([...known.values()]);
  }
  plan(local){
    this.#session();this.#mergeLocal(local);
    return planSelectiveReplica({records:this.entries,now:this.clock(),months:this.config.months,pinnedObjects:[...this.pins],localRevisions:local.map(e=>e.revisionId),pendingRevisions:local.filter(e=>!this.confirmed.has(e.revisionId)).map(e=>e.revisionId),maxDownloadBytes:this.config.maxDownloadBytes});
  }
  async #verified(entry,raw,g){
    check(new TextEncoder().encode(raw).length===entry.ciphertextBytes&&await ciphertextDigest(raw)===entry.sha256,'BODY_HASH');this.#assert(g);
    const record=await decryptRecord(this.#header,this.#key,parseEnvelopeJSON(raw));this.#assert(g);
    check(canonical(descriptor(record,entry,this.entries))===canonical(entry),'BODY_METADATA');return record;
  }
  sync(localProvider){
    const g=this.#session();return this.#serial(async()=>{
      try{
        this.#assert(g);
        const local=await localProvider();this.#assert(g);this.#mergeLocal(local);
        this.#status('syncing',{pending:local.filter(e=>!this.confirmed.has(e.revisionId)).length});
        await this.#persist(g); // Offline saves enter the journal before network access.
        await this.transport.connect();this.#assert(g);
        await this.io.syncPassword?.(this.#header,this.#key,this.transport);this.#assert(g);
        const sequence=this.transport.sequence?await this.transport.sequence():'0';this.#assert(g);
        await this.#catalogue(g);
        let plan=this.plan(local);this.#status('syncing',{pending:plan.pendingRevisions.length,downloadBytes:plan.downloadBytes,conflicts:plan.conflictingObjects.length});
        await this.#persist(g); // Freeze local descriptors before any remote effect.
        const pending=new Set(plan.pendingRevisions),byId=new Map(this.entries.map(e=>[e.revisionId,e]));
        // Parents and media descriptors precede dependents. Missing bodies are not ACKs.
        while(pending.size){
          const eligible=[...pending].filter(id=>byId.get(id).parents.every(p=>!pending.has(p))&&byId.get(id).attachments.every(obj=>!local.some(e=>e.objectId===obj&&pending.has(e.revisionId))));
          check(eligible.length,'OUTBOX_DEPENDENCY');
          for(const id of eligible){
            const entry=byId.get(id),raw=await this.io.readRecord(entry);this.#assert(g);await this.#verified(entry,raw,g);
            await this.transport.writeRecord(entry,raw);this.#assert(g);
            await this.#append('rv-revision:'+id,[entry],g);
            this.confirmed.add(id);pending.delete(id);await this.#persist(g);
            this.#status('syncing',{pending:pending.size});
          }
        }
        // Full replicas leave incoming hydration to LiveSync; selection never
        // changes their existing full-replica filter or database.
        if(this.mode==='selective'){
          plan=this.plan(local);
          if(!plan.withinBudget){this.#status('budget',{downloadBytes:plan.downloadBytes,pending:0});return plan;}
          for(const item of plan.downloads){
            const entry=byId.get(item.revisionId),raw=await this.transport.readRecord(entry);this.#assert(g);await this.#verified(entry,raw,g);
            if(await this.io.hasRecord(entry)){await this.#verified(entry,await this.io.readRecord(entry),g);}
            else {this.#assert(g);await this.io.writeRecord(entry,raw);this.#assert(g);await this.#verified(entry,await this.io.readRecord(entry),g);}
            this.confirmed.add(entry.revisionId);
          }
        }
        await this.#persist(g);this.#assert(g);const finalPlan=this.plan(await localProvider());this.#assert(g);this.#status('current',{error:null,pending:finalPlan.pendingRevisions.length,lastSuccess:this.clock(),downloadBytes:plan.downloadBytes,conflicts:finalPlan.conflictingObjects.length});
        this.lastSequence=sequence;await this.onChange();return plan;
      }catch(e){if(g===this.#generation)this.#status('retry',{error:e.code||'REPLICA_FAILED'});throw e;}
    });
  }
  pin(objectId){const g=this.#session();return this.#serial(async()=>{this.#assert(g);check(this.entries.some(e=>e.objectId===objectId&&e.kind==='note'));this.pins.add(objectId);await this.#persist(g);});}
  archive({deleted=false}={}){this.#session();return heads(this.entries).filter(e=>e.kind==='note'&&!!e.deleted===deleted).map(e=>({...e,pinned:this.pins.has(e.objectId)}));}
  setWindow(months,maxDownloadBytes=this.config.maxDownloadBytes){
    const g=this.#session();return this.#serial(async()=>{this.#assert(g);check(Number.isInteger(months)&&months>=1&&months<=120&&Number.isSafeInteger(maxDownloadBytes)&&maxDownloadBytes>=0&&maxDownloadBytes<=1024*1024*1024);
    const next={...this.config,months,maxDownloadBytes};const raw=await encryptReplicaMessage(this.#header,this.#key,'config',next);this.#assert(g);await this.io.writeConfig(raw);this.#assert(g);this.config=next;});
  }
  async enrollment(){
    const g=this.#session();const config={...this.config,mode:'selective'};
    const encrypted=await encryptReplicaMessage(this.#header,this.#key,'config',config);this.#assert(g);
    const credential=await this.io.readPassword?.();this.#assert(g);
    return {schema:'cipherfold-selective-enrollment/v1',header:this.#header,config:encrypted,...(credential?{credential}: {})};
  }
  async watch(localProvider){
    const g=this.#session();let since=this.lastSequence??'0';
    while(g===this.#generation){
      try{
        const changes=await this.transport.changes(since);this.#assert(g);check(changes&&Array.isArray(changes.results)&&changes.last_seq!==undefined);since=changes.last_seq;
        if(changes.results.length)await this.sync(localProvider);
      }catch{if(g===this.#generation)this.#status('retry');return;} // Retry only on unlock/open/manual action, no busy error loop.
    }
  }
  /** Explicit one-time publisher. Resumable fixed IDs; no edits are accepted as
   * remotely durable merely because a catalogue entry exists. */
  async bootstrap(password,connection,localProvider,{months=12,maxDownloadBytes=64*1024*1024}={}){
    check(!this.#preparing,'REPLICA_PREPARING');this.#preparing=true;let generation;
    try{
    check(!await this.io.readConfig(),'ALREADY_ENROLLED');
    this.lock();const g=this.#generation;const header=parseHeaderJSON(await this.io.readHeader()),key=await (this.io.unlockKey??unlockVault)(header,password);check(g===this.#generation,'REPLICA_LOCKED');this.#header=header;this.#key=key;
    generation=g;
    this.config={version:1,mode:'full',connection,baseId:'rv-catalog:'+crypto.randomUUID(),months,maxDownloadBytes};
    this.transport=this.transportFactory(connection);await this.transport.connect();this.#assert(g);
    this.entries=mergeEntries(await localProvider());this.#assert(g);
    planSelectiveReplica({records:this.entries,now:this.clock()});
    this.#status('publishing',{total:this.entries.length,done:0});
    // Verify the wrapped key belongs to the same existing remote vault.
    const remoteHeader=await this.transport.readFile('CipherfoldStore/vault.rvkey');this.#assert(g);check(canonical(parseHeaderJSON(remoteHeader))===canonical(this.#header),'REMOTE_VAULT');
    let done=0,next=0,stopped=false;
    const publish=async()=>{
      try{
        while(!stopped&&next<this.entries.length){
          this.#assert(g);const entry=this.entries[next++];
          const raw=await this.io.readRecord(entry);this.#assert(g);await this.#verified(entry,raw,g);
          if(stopped)return;
          await this.transport.writeRecord(entry,raw);this.#assert(g);if(stopped)return;
          // Independent immutable records can be verified concurrently. The
          // complete base and enrollment are committed only after every worker.
          await this.#append('rv-revision:'+entry.revisionId,[entry],g);this.#assert(g);
          this.confirmed.add(entry.revisionId);this.#status('publishing',{done:++done});
        }
      }catch(error){stopped=true;throw error;}
    };
    // Bound both server pressure and in-flight ciphertext memory. Drain all
    // workers on failure so a retry cannot overlap an earlier publication.
    const results=await Promise.allSettled(Array.from({length:Math.min(4,this.entries.length)},publish));
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;this.#assert(g);
    await this.#append(this.config.baseId,this.entries,g);
    const encrypted=await encryptReplicaMessage(this.#header,this.#key,'config',this.config);this.#assert(g);
    // Commit enrollment last: an interrupted checkpoint must leave preparation
    // retryable, and the runtime must not sync/export an unfinished catalogue.
    await this.#persist(g);await this.#persist(g);
    await this.io.writeConfig(encrypted);this.#assert(g);
    check(canonical(await decryptReplicaMessage(this.#header,this.#key,'config',await this.io.readConfig()))===canonical(this.config),'CONFIG_READBACK');this.#assert(g);
    this.#enrolled=true;
    this.#status('current',{error:null,pending:0,lastSuccess:this.clock()});return this.enrollment();
    }catch(error){if(generation!==undefined&&generation===this.#generation){this.lock();this.#status('retry',{error:error.code||'PREPARATION_FAILED'});}throw error;}
    finally{this.#preparing=false;}
  }
}
