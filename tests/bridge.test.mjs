import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
class FakeFile{constructor(path,stat){this.path=path;this.stat=stat;}cache(value){this.cached=value;}}
globalThis.document={hidden:false};
globalThis.__nativeObs={Plugin:class{addCommand(){}addRibbonIcon(){}addStatusBarItem(){return {setText(){}};}registerEvent(){}registerDomEvent(){}register(fn){(this.cleanup??=[]).push(fn);}},Modal:class{},Notice:class{},TFile:FakeFile,WorkspaceLeaf:class{async openFile(){}}};
let source=await fs.readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
source=source.replace("import {Plugin,Modal,Notice,TFile,WorkspaceLeaf,requestUrl} from 'obsidian';","const {Plugin,Modal,Notice,TFile,WorkspaceLeaf,requestUrl}=globalThis.__nativeObs;")
 .replace("'./virtual-store.mjs'",JSON.stringify(new URL('../src/virtual-store.mjs',import.meta.url).href))
 .replace("'./crypto.mjs'",JSON.stringify(new URL('../src/crypto.mjs',import.meta.url).href))
 .replace("'./note-workflow.mjs'",JSON.stringify(new URL('../src/note-workflow.mjs',import.meta.url).href))
 .replace("'./resource-cache.mjs'",JSON.stringify(new URL('../src/resource-cache.mjs',import.meta.url).href));
source=source.replace(/'\.\/([^']+\.mjs)'/g,(_,name)=>JSON.stringify(new URL('../src/'+name,import.meta.url).href)).replace(/import \{codecFactory\} from [^;]+;/, 'const codecFactory=()=>{throw Error("No network in bridge test");};');
const {default:NativePlugin}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const password='synthetic-native-bridge-password';
for(const phase of ['disk','preload','cache-clear'])test(`unload during ${phase} startup cannot install hooks or reactivate the plugin`,async()=>{
 let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 const originalWrite=async()=>{},originalSave=()=>{};
 const adapter={write:originalWrite,exists:async()=>false,list:async()=>{if(phase==='disk'){entered();await gate;}return {files:[],folders:[]};}};
 const cache={workQueue:{promise:Promise.resolve()},transactionSave:originalSave,
  get preloadPromise(){if(phase==='preload'){entered();return gate;}},
  async clear(){if(phase==='cache-clear'){entered();await gate;}}};
 const app={vault:{adapter,configDir:'.test-config',onChange(){}},metadataCache:cache};
 const plugin=new NativePlugin();plugin.app=app;
 const starting=plugin.start();await reached;plugin.onunload();release();await starting;
 assert.equal(plugin.disposed,true);assert.equal(plugin.ready,false);
 assert.equal(adapter.write,originalWrite);assert.equal(cache.transactionSave,originalSave);
 assert.equal(app[Symbol.for('cipherfold:guard-owner')],undefined);
 assert(!plugin.store?.isUnlocked);
});
async function fixture(t,{recoveryEnabled=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cipherfold-native-bridge-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const physical=p=>path.join(root,p),map=new Map(),diskWrites=[];
 const a={
  exists:p=>fs.access(physical(p)).then(()=>true,()=>false),
  stat:async p=>{try{const s=await fs.stat(physical(p));return {type:s.isFile()?'file':'folder',ctime:s.birthtimeMs,mtime:s.mtimeMs,size:s.size};}catch{return null;}},
  list:async p=>{const e=await fs.readdir(physical(p),{withFileTypes:true});return {files:e.filter(x=>x.isFile()).map(x=>p+'/'+x.name),folders:e.filter(x=>x.isDirectory()).map(x=>p+'/'+x.name)};},
  read:p=>fs.readFile(physical(p),'utf8'),readBinary:async p=>(await fs.readFile(physical(p))).buffer,
  write:async(p,s)=>{diskWrites.push({path:p,data:s});await fs.mkdir(path.dirname(physical(p)),{recursive:true});await fs.writeFile(physical(p),s);},
  writeBinary:async(p,b)=>{diskWrites.push({path:p,data:b});await fs.writeFile(physical(p),new Uint8Array(b));},
  mkdir:p=>fs.mkdir(physical(p),{recursive:true}),remove:p=>fs.unlink(physical(p)),rmdir:p=>fs.rmdir(physical(p)),
  rename:(a,b)=>fs.rename(physical(a),physical(b)),copy:(a,b)=>fs.copyFile(physical(a),physical(b)),
  getResourcePath:p=>'file://'+physical(p),
 };
 const vault={adapter:a,configDir:'.obsidian',getName:()=> 'Synthetic Native Test',on:()=>({}),getAllLoadedFiles:()=>[...map.values()],getAbstractFileByPath:p=>map.get(p),getFileByPath:p=>map.get(p),
  onChange(event,p,old,stat){if(event==='file-created')map.set(p,new FakeFile(p,stat));else if(event==='folder-created')map.set(p,{path:p,children:[]});else if(event==='renamed'){const file=map.get(old);map.delete(old);file.path=p;map.set(p,file);}else if(event==='modified')map.get(p).stat=stat;else if(event.endsWith('removed'))map.delete(p);},
 };
 vault.getAbstractFileByPathInsensitive=p=>[...map.values()].find(f=>f.path.normalize('NFC').toLowerCase()===p.normalize('NFC').toLowerCase());
 // Exact native1.14.5 naming algorithm, also used by FileManager.createNewFile.
 vault.getAvailablePath=function(base,ext){const name=b=>ext?b+'.'+ext:b;let n=1,p=name(base);while(this.getAbstractFileByPathInsensitive(p))p=name(base+' '+n++);return p;};
 const leaves=[],cache={workQueue:{promise:Promise.resolve()},transactionSave(){throw Error('metadata must not persist');},async clear(){this.diskCleared=true;},cleanupDeletedCache(){},blockCache:{clear(){}}};
 const app={vault,metadataCache:cache,internalPlugins:{plugins:{'file-recovery':{enabled:recoveryEnabled,disable(){this.enabled=false;}}},disablePlugin:async()=>{}},plugins:{plugins:{'obsidian-livesync':{core:{settings:{syncOnlyRegEx:'^CipherfoldStore/',syncIgnoreRegEx:'^Native/',syncInternalFiles:false,usePluginSync:false,usePluginSyncV2:false}}}}},
  saveLocalStorage(){throw Error('local storage must not persist');},loadLocalStorage(){return null;},workspace:{onLayoutReady:f=>f(),iterateAllLeaves:fn=>{for(const leaf of leaves)if(fn(leaf))break;},recentFileTracker:{lastOpenFiles:[]},getLeaf:()=>({async openFile(){}})},
 };
 app.plugins.plugins['obsidian-livesync'].core.storageAccess={vault:{isTargetFile:async()=>true,isTargetFileInExtra:async()=>true},vaultAccess:{adapter:{storage:{read:p=>a.read(p)},vault:{read:f=>a.read(f.path)},getFiles:()=>[...map.values()]}}};
 app.fileManager={fileParentCreatorByType:{},registerFileParentCreator(ext,fn){this.fileParentCreatorByType[ext]=fn;}};
 app.fileManager.createNewFolder=async parent=>{const p=vault.getAvailablePath((parent?.path?parent.path+'/':'')+'Untitled');await a.mkdir(p);return map.get(p);};
 app.workspace.getActiveFile=()=>app.workspace.activeFile;
 app.workspace.getLeavesOfType=type=>leaves.filter(l=>l.view.getViewType?.()===type);
 const plugin=new NativePlugin();plugin.app=app;await plugin.start();await plugin.store.initialize(password);plugin.acceptWrites=true;await plugin.publish();
 const push=leaves.push.bind(leaves);leaves.push=(...items)=>{for(const leaf of items)if(leaf.view?.file&&typeof leaf.view.getViewData==='function')plugin.captureEditor(leaf.view,leaf.view.file);return push(...items);};
 t.after(()=>{clearTimeout(plugin.refreshTimer);plugin.sessionLock?.idle.stop();for(const fn of plugin.cleanup||[])fn();plugin.store.lock();});
 return {plugin,app,a,root,map,diskWrites,leaves,cache};
}
test('native folder toolbar root fallback, context child and cleanup preserve protected boundary',async t=>{
 const {plugin,app,a,root}=await fixture(t);
 const folder=await app.fileManager.createNewFolder();assert.equal(folder.path,'Native/Untitled');
 assert.equal((await app.fileManager.createNewFolder({path:'',children:[]})).path,'Native/Untitled 1');
 assert.equal((await app.fileManager.createNewFolder(folder)).path,'Native/Untitled/Untitled');
 assert.equal(await fs.access(path.join(root,'Native')).then(()=>true,()=>false),false);
 plugin.acceptWrites=false;assert.throws(()=>app.fileManager.createNewFolder(),e=>e.code==='LOCKED');
 for(const fn of plugin.cleanup)fn();
 await assert.rejects(app.fileManager.createNewFolder());
});
test('plugin disable persists installed IDs without allowing arbitrary config plaintext',async t=>{
 const {app,a,plugin}=await fixture(t);app.plugins.manifests={cipherfold:{},'dictation-bridge':{}};
 const config=app.vault.configDir+'/community-plugins.json';
 await a.write(config,'["dictation-bridge"]');assert.equal(await plugin.raw.read(config),'["dictation-bridge"]');
 await assert.rejects(a.write(config,'["SYNTHETIC_PRIVATE_TITLE"]'));
 await assert.rejects(a.write(config,'{"title":"SYNTHETIC_PRIVATE_TITLE"}'));
 await assert.rejects(a.writeBinary(config,new TextEncoder().encode('["cipherfold"]').buffer));
 assert.equal(await plugin.raw.read(config),'["dictation-bridge"]');
 await a.write(app.vault.configDir+'/workspace.json','SYNTHETIC_PRIVATE_TITLE');
 assert.equal(await plugin.raw.exists(app.vault.configDir+'/workspace.json'),false);
});
test('native adapter preserves UTF8 binary metadata reads and never creates plaintext files',async t=>{
 const {a,root,map}=await fixture(t);await a.write('Native/Русский.md','# Заголовок\nNATIVE_SECRET_MARKER');
 assert.equal(new TextDecoder().decode(await a.readBinary('Native/Русский.md')),'# Заголовок\nNATIVE_SECRET_MARKER');
 assert(map.get('Native/Русский.md') instanceof FakeFile);
 assert.equal(await fs.access(path.join(root,'Native')).then(()=>true,()=>false),false);
 for(const f of await fs.readdir(path.join(root,'CipherfoldStore'))){const s=await fs.readFile(path.join(root,'CipherfoldStore',f),'utf8');assert(!s.includes('NATIVE_SECRET_MARKER'));assert(!s.includes('Русский'));}
});
test('normal creation resolves active notebook, selected folder, explicit source and safe Native fallback',async t=>{
 const {plugin,app,a,map,leaves}=await fixture(t);
 await a.write('Native/Book A/Existing.md','A');await a.write('Native/Book B/Existing.md','B');
 for(const file of map.values())file.parent=map.get(file.path.slice(0,file.path.lastIndexOf('/')));
 const choose=app.fileManager.fileParentCreatorByType.md;
 app.workspace.activeFile=map.get('Native/Book A/Existing.md');
 assert.equal(choose(app.workspace.activeFile.path).path,'Native/Book A');
 plugin.noteWorkflow.folder='Native/Book B';assert.equal(choose(app.workspace.activeFile.path).path,'Native/Book B');
 assert.equal(choose('Native/Book A/Existing.md').path,'Native/Book B');
 app.workspace.activeFile=map.get('Native/Book B/Existing.md');
 assert.equal(choose('Native/Book A/Existing.md').path,'Native/Book A');
 leaves.push({view:{getViewType:()=> 'file-explorer',containerEl:{contains:()=>true},tree:{focusedItem:{file:map.get('Native/Book A')}}}});
 assert.equal(choose(app.workspace.activeFile.path).path,'Native/Book A');
 leaves.length=0;plugin.noteWorkflow.folder=null;app.workspace.activeFile=null;
 assert.equal(choose('').path,'Native');
 plugin.acceptWrites=false;assert.throws(()=>choose(''),e=>e.code==='LOCKED');
});
test('normal new-note naming skips unloaded archive names without loading or changing their bodies',async t=>{
 const {plugin,app,a,root,map,diskWrites}=await fixture(t);
 for(const suffix of ['', ' 1', ' 2'])await a.write('Native/Без названия'+suffix+'.md','loaded');
 const hidden=await plugin.store.write('Native/Без названия 3.md','ARCHIVED_BODY');
 const catalogue=await plugin.store.replicaEntries(),hiddenPath=`CipherfoldStore/${hidden.objectId}_${hidden.revisionId}.renc`;
 await fs.unlink(path.join(root,hiddenPath));plugin.store.lock();map.clear();plugin.projected.clear();
 await plugin.store.unlock(password,{replicaEntries:catalogue});await plugin.publish();
 assert.equal(map.has('Native/Без названия 3.md'),false);
 const before=diskWrites.length,candidate=app.vault.getAvailablePath('Native/Без названия','md');
 assert.equal(diskWrites.length,before);
 await a.write(candidate,'NEW_BODY');assert.equal(candidate,'Native/Без названия 4.md');assert.equal(await a.read(candidate),'NEW_BODY');
 assert.equal(await plugin.raw.exists(hiddenPath),false);assert.equal(plugin.store.conflicts().length,0);
 await a.rename(candidate,'Native/Notebook/Named.md');assert.equal(await a.read('Native/Notebook/Named.md'),'NEW_BODY');
});
test('new names respect Unicode, archive folders and hidden conflicts while retaining native naming outside Native',async t=>{
 const {plugin,app,a,root,map}=await fixture(t);
 const records=[];
 for(const name of ['Native/Café.md','Native/Folder.md/Child.md','Native/Parent.md','Native/Old.md'])records.push(await plugin.store.write(name,'archive'));
 await plugin.store.rename('Native/Old.md','Native/Renamed.md');
 const catalogue=await plugin.store.replicaEntries();
 for(const name of await fs.readdir(path.join(root,'CipherfoldStore')))if(name.endsWith('.renc'))await fs.unlink(path.join(root,'CipherfoldStore',name));
 plugin.store.lock();map.clear();plugin.projected.clear();await plugin.store.unlock(password,{replicaEntries:catalogue});await plugin.publish();
 assert.equal(app.vault.getAvailablePath('Native/CAFE\u0301','md'),'Native/CAFE\u0301 1.md');
 assert.equal(app.vault.getAvailablePath('Native/Folder','md'),'Native/Folder 1.md');
 assert.equal(app.vault.getAvailablePath('Native/Old','md'),'Native/Old.md');
 assert.throws(()=>app.vault.getAvailablePath('Native/Parent.md/Child','md'),e=>e.code==='STORE_CONFLICT');
 await assert.rejects(a.write('Native/Renamed.md','overwrite'),e=>e.code==='STORE_CONFLICT');
 const branch={...catalogue.find(r=>r.name==='Native/Parent.md'),revisionId:crypto.randomUUID(),parents:[],objectId:crypto.randomUUID()};
 plugin.store.setReplicaCatalogue([...catalogue,branch]);await plugin.store.refresh();
 assert.equal(app.vault.getAvailablePath('Native/Parent','md'),'Native/Parent 1.md');
 map.set('Outside.md',new FakeFile('Outside.md',{}));assert.equal(app.vault.getAvailablePath('Outside','md'),'Outside 1.md');
 plugin.store.lock();assert.throws(()=>app.vault.getAvailablePath('Native/New','md'),e=>e.code==='LOCKED');
 for(const fn of plugin.cleanup)fn();assert.equal(app.vault.getAvailablePath('Native/Parent','md'),'Native/Parent.md');
});
test('native rename saves pending body and preserves TFile identity and editable tab',async t=>{
 const {plugin,a,map,leaves,root}=await fixture(t);await a.write('Native/A.md','before');
 const file=map.get('Native/A.md'),view={file,containerEl:{inert:false},draft:'latest unsaved text',getViewData(){return this.draft;},save(){return a.write(this.file.path,this.draft);}};
 leaves.push({view});const objectId=plugin.store.stat(file.path).objectId;
 await a.rename('Native/A.md','Native/Notebook/Renamed.md');
 assert.equal(view.file,file);assert.equal(file.path,'Native/Notebook/Renamed.md');assert.equal(map.get(file.path),file);
 assert.equal(map.has('Native/A.md'),false);assert.equal(await a.read(file.path),'latest unsaved text');
 assert.equal(plugin.store.stat(file.path).objectId,objectId);assert.equal(view.containerEl.inert,false);
 await a.write(file.path,'edit after rename');assert.equal(await a.read(file.path),'edit after rename');
 assert.equal(await fs.access(path.join(root,'Native')).then(()=>true,()=>false),false);
});
test('rename cancels on save failure or divergent tabs without moving or dropping drafts',async t=>{
 const {a,map,leaves}=await fixture(t);await a.write('Native/A.md','before');
 const view={file:map.get('Native/A.md'),containerEl:{inert:false},getViewData:()=> 'unsaved',save:async()=>{throw Error('private failure details');}};
 leaves.push({view});await assert.rejects(a.rename('Native/A.md','Native/B.md'));
 assert(map.has('Native/A.md'));assert(!map.has('Native/B.md'));assert.equal(view.containerEl.inert,false);
 assert.equal(await a.read('Native/A.md'),'before');
 leaves.push({view:{...view,getViewData:()=> 'different unsaved'}});
 await assert.rejects(a.rename('Native/A.md','Native/B.md'),e=>e.code==='DIVERGENT_EDITORS');
 assert.equal(await a.read('Native/A.md'),'before');
});
test('remote rename projection retains identity and removes old path without a duplicate file',async t=>{
 const {plugin,a,map}=await fixture(t);await a.write('Native/A.md','body');const file=map.get('Native/A.md');
 await plugin.store.rename('Native/A.md','Native/B.md');await plugin.publish();
 assert.equal(map.has('Native/A.md'),false);assert.equal(map.get('Native/B.md'),file);
 assert.equal(plugin.projected.has('Native/A.md'),false);assert.equal(plugin.projected.size,1);
 await plugin.publish();assert.equal(map.get('Native/B.md'),file);
});
test('empty folder destination collision is rejected before a rename revision is written',async t=>{
 const {plugin,a,map,diskWrites}=await fixture(t);await a.write('Native/A.md','before');
 await a.mkdir('Native/Occupied.md');const count=diskWrites.length;
 await assert.rejects(a.rename('Native/A.md','Native/Occupied.md'),e=>e.code==='STORE_CONFLICT');
 assert.equal(diskWrites.length,count);assert(map.has('Native/A.md'));
 assert.equal(await plugin.store.read('Native/A.md'),'before');
});
test('lock waits for an in-flight rename and restart recovers the completed new name',async t=>{
 const {plugin,a}=await fixture(t);await a.write('Native/A.md','body');
 const write=plugin.raw.write;let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 plugin.raw.write=async(...args)=>{if(args[0].endsWith('.renc')){enter();await gate;}return write(...args);};
 const renaming=a.rename('Native/A.md','Native/B.md');await entered;
 const closing=plugin.lock();release();await renaming;assert.equal(await closing,true);
 assert.equal(plugin.store.isUnlocked,false);await plugin.store.unlock(password);
 assert.equal(plugin.store.exists('Native/A.md'),false);assert.equal(await plugin.store.read('Native/B.md'),'body');
});
test('workspace, query history, folds and metadata persistence stay volatile',async t=>{
 const {a,app,cache,diskWrites}=await fixture(t);
 await a.write('.obsidian/workspace.json',JSON.stringify({query:'SECRET',file:'Native/private.md'}));
 await a.write('.obsidian/workspace-mobile.json',JSON.stringify({query:'SECRET'}));
 app.saveLocalStorage('recent-searches',['SECRET']);app.saveLocalStorage('note-fold-Native/private.md',{fold:1});
 assert.deepEqual(app.loadLocalStorage('recent-searches'),['SECRET']);
 assert.equal(cache.transactionSave,null);assert(cache.diskCleared);
 assert(!diskWrites.some(x=>x.path.includes('workspace')));
 assert.equal(await app.internalPlugins.plugins['file-recovery'].enable(),false);
});
test('parallel appends and process run atomically at the native bridge',async t=>{
 const {a}=await fixture(t);await a.write('Native/A.md','A');
 await Promise.all([a.append('Native/A.md','B'),a.append('Native/A.md','C')]);
 assert.equal(await a.read('Native/A.md'),'ABC');
 await a.process('Native/A.md',s=>s+'D');assert.equal(await a.read('Native/A.md'),'ABCD');
});
test('LiveSync filter drift rejects native writes before any new ciphertext is persisted',async t=>{
 const {a,app,diskWrites}=await fixture(t);await a.write('Native/A.md','original');const n=diskWrites.length;
 app.plugins.plugins['obsidian-livesync'].core.settings.syncOnlyRegEx='';
 await assert.rejects(a.write('Native/A.md','unexpected'));assert.equal(diskWrites.length,n);
});
test('LiveSync raw boundary excludes native names and reads even if regex settings drift',async t=>{
 const {plugin,a,app}=await fixture(t);await a.write('Native/A.md','secret');plugin.validateSync();
 const core=app.plugins.plugins['obsidian-livesync'].core;core.settings.syncOnlyRegEx='';
 assert.equal(await core.storageAccess.vault.isTargetFile('Native/A.md'),false);
 assert.equal(await core.storageAccess.vault.isTargetFile('CipherfoldStore/vault.rvkey'),true);
 assert.throws(()=>core.storageAccess.vaultAccess.adapter.storage.read('Native/A.md'));
 assert.equal(core.storageAccess.vaultAccess.adapter.getFiles().some(f=>f.path.startsWith('Native/')),false);
});
test('local acceleration cache stays encrypted and outside LiveSync; native reads and progress survive a lock cycle',async t=>{
 const {plugin,a,app,root}=await fixture(t);
 await a.write('Native/Secret.md','CATALOG_NATIVE_SENTINEL');
 await a.writeBinary('Native/Secret.png',Uint8Array.of(137,80,78,71).buffer);
 const cachePath='.obsidian/plugins/cipherfold/attachment-catalog.rvcat';
 const cache=await fs.readFile(path.join(root,cachePath),'utf8');assert(!cache.includes('Secret'));assert(!cache.includes('image/png'));
 plugin.validateSync();assert.equal(await app.plugins.plugins['obsidian-livesync'].core.storageAccess.vault.isTargetFile(cachePath),false);
 assert.equal(await plugin.lock(),true);const progress=[];await plugin.unlock(password,{onProgress:p=>progress.push(p)});
 assert.equal(plugin.lastUnlockMetrics.lazyAttachments,1);assert.equal(plugin.lastUnlockMetrics.decryptedRecords,1);
 assert(progress.some(p=>p.stage==='publish'));assert(progress.some(p=>p.stage==='open'));
 assert.equal(await a.read('Native/Secret.md'),'CATALOG_NATIVE_SENTINEL');
 assert.deepEqual(new Uint8Array(await a.readBinary('Native/Secret.png')),Uint8Array.of(137,80,78,71));
 assert.equal(await fs.access(path.join(root,'Native')).then(()=>true,()=>false),false);
});
test('lock drains native save, removes projections, clears volatile state and fails closed',async t=>{
 const {plugin,a,map,leaves,app}=await fixture(t);await a.write('Native/A.md','before');
 let detached=false;
 leaves.push({view:{file:map.get('Native/A.md'),getViewType:()=> 'markdown',save:()=>a.write('Native/A.md','saved on lock')},detach(){detached=true;}});
 app.saveLocalStorage('recent-searches',['before']);
 assert.equal(await plugin.lock(),true);assert(detached);assert.equal(map.size,0);assert.equal(plugin.store.isUnlocked,false);
 assert.equal(app.loadLocalStorage('recent-searches'),null);await assert.rejects(a.write('Native/A.md','blocked'));await assert.rejects(a.read('Native/A.md'));
 await plugin.store.unlock(password);assert.equal(await plugin.store.read('Native/A.md'),'saved on lock');
});
test('failed native save cancels lock and retains the editable session',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','before');
 leaves.push({view:{file:map.get('Native/A.md'),save:async()=>{throw Error('synthetic failure');}},detach(){throw Error('must retain editor');}});
 assert.equal(await plugin.lock(),false);assert(plugin.store.isUnlocked);assert(map.has('Native/A.md'));assert(plugin.acceptWrites);
});
test('multi-pane lock visits every editor and clears every sensitive pane',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);const detached=[];
 await a.write('Native/A.md','old-a');await a.write('Native/B.md','old-b');
 leaves.push({view:{getViewType:()=> 'search'},detach(){detached.push('search');}});
 for(const name of ['A','B'])leaves.push({view:{file:map.get(`Native/${name}.md`),getViewType:()=> 'markdown',getViewData:()=>`saved-${name}`,save:()=>a.write(`Native/${name}.md`,`saved-${name}`)},detach(){detached.push(name);}});
 leaves.push({view:{file:map.get('Native/B.md'),getViewType:()=> 'outline'},detach(){detached.push('outline');}});
 assert.equal(await plugin.lock(),true);assert.deepEqual(detached,['search','A','B','outline']);assert.equal(map.size,0);
 await plugin.store.unlock(password);assert.equal(await plugin.store.read('Native/A.md'),'saved-A');assert.equal(await plugin.store.read('Native/B.md'),'saved-B');
});
test('multi-pane failed later save keeps all drafts and cancels lock',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','old');let attempted=false;
 leaves.push({view:{getViewType:()=> 'search'},detach(){throw Error('must retain search');}});
 leaves.push({view:{file:map.get('Native/A.md'),getViewData:()=> 'unsaved',save:async()=>{attempted=true;throw Error('synthetic later save failure');}},detach(){throw Error('must retain draft');}});
 assert.equal(await plugin.lock(),false);assert(attempted);assert(plugin.store.isUnlocked);assert(plugin.acceptWrites);
});
test('lock accepts recreated read-only panes and detaches their current instances',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','saved');let detached=false;
 leaves.push({view:{file:map.get('Native/A.md'),getViewData:()=> 'saved',async save(){
  leaves.push({view:{file:map.get('Native/A.md'),getViewType:()=> 'outline'},detach(){detached=true;}});
 }},detach(){}});
 assert.equal(await plugin.lock(),true);assert(detached);assert.equal(plugin.store.isUnlocked,false);
});
test('lock refuses a new editable pane that appeared while draining saves',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','saved');
 leaves.push({view:{file:map.get('Native/A.md'),getViewData:()=> 'saved',async save(){
  leaves.push({view:{file:map.get('Native/A.md'),getViewData:()=> 'UNSAVED NEW DRAFT'},detach(){throw Error('must preserve draft');}});
 }},detach(){throw Error('must preserve draft');}});
 assert.equal(await plugin.lock(),false);assert(plugin.store.isUnlocked);
});
test('hiding during unlock no longer cancels it, but a deliberate concurrent lock still wins',async t=>{
 const {plugin}=await fixture(t);await plugin.lock();document.hidden=true;
 try{await plugin.unlock(password);assert.equal(plugin.store.isUnlocked,true);}finally{document.hidden=false;}
 await plugin.lock();
 let release;plugin.queue=new Promise(r=>release=r);
 const opening=plugin.unlock(password);const closing=plugin.lock();release();
 await assert.rejects(opening);await closing;assert.equal(plugin.store.isUnlocked,false);
});

test('unlock restores active object after rename, and persists only its UUID across reload',async t=>{
 const {plugin,a,app,map,root}=await fixture(t);
 await a.write('Native/First.md','first');await a.write('Native/CONFIDENTIAL_TITLE.md','PRIVATE_BODY');
 app.workspace.activeFile=map.get('Native/CONFIDENTIAL_TITLE.md');
 const id=plugin.store.stat(app.workspace.activeFile.path).objectId;
 await plugin.lock();
 const text=await fs.readFile(path.join(root,'.obsidian/plugins/cipherfold/session-state.json'),'utf8');
 assert(!text.includes('CONFIDENTIAL'));assert(!text.includes('PRIVATE_BODY'));assert(!text.includes('Native/'));assert(text.includes(id));
 const {installSessionLock}=await import('../src/session-lock.mjs');
 plugin.sessionLock=await installSessionLock(plugin,globalThis.__nativeObs);
 let opened;app.workspace.getLeaf=()=>({openFile:async file=>{opened=file.path;}});
 await plugin.unlock(password);assert.equal(opened,'Native/CONFIDENTIAL_TITLE.md');
 await a.rename(opened,'Native/Renamed.md');app.workspace.activeFile=map.get('Native/Renamed.md');
 await plugin.lock();await plugin.unlock(password);assert.equal(opened,'Native/Renamed.md');
 app.workspace.activeFile=null;await a.remove(opened);await plugin.lock();await plugin.unlock(password);assert.equal(opened,'Native/First.md');
});

test('timeout preference persists through guarded adapter and fresh session installation',async t=>{
 const {plugin,root}=await fixture(t);assert.equal(plugin.sessionLock.settings.autoLockMinutes,5);
 await plugin.sessionLock.setMinutes(12);
 const {installSessionLock}=await import('../src/session-lock.mjs');
 const restored=await installSessionLock(plugin,globalThis.__nativeObs);assert.equal(restored.settings.autoLockMinutes,12);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.obsidian/plugins/cipherfold/session-state.json'),'utf8')).autoLockMinutes,12);
 await assert.rejects(restored.setMinutes(0));assert.equal(restored.settings.autoLockMinutes,12);
});
test('physical and outside-namespace writes cannot smuggle plain note contents',async t=>{
 const {a}=await fixture(t);
 for(const p of ['outside.md','CipherfoldStore/secret.md','CipherfoldStore/vault.rvkey'])await assert.rejects(a.write(p,'plaintext'));
 await a.write('Native/A.md','text');await assert.rejects(a.rename('Native/A.md','elsewhere.md'));await assert.rejects(a.remove('CipherfoldStore/vault.rvkey'));
});

test('property names and other core configuration remain in RAM; only LiveSync settings persist',async t=>{
 const {plugin,a,diskWrites,app}=await fixture(t);
 const secret=JSON.stringify({types:{CONFIDENTIAL_PROPERTY_NAME:'text'}});
 await a.write('.obsidian/types.json',secret);
 await a.writeBinary('.obsidian/other-core.json',new TextEncoder().encode(secret).buffer);
 assert.equal(await a.read('.obsidian/types.json'),secret);
 assert.equal(new TextDecoder().decode(await a.readBinary('.obsidian/other-core.json')),secret);
 assert(await a.exists('.obsidian/types.json'));assert((await a.stat('.obsidian/types.json')).size>0);
 assert(!diskWrites.some(x=>String(x.data).includes('CONFIDENTIAL_PROPERTY_NAME')));
 await a.write('.obsidian/plugins/obsidian-livesync/data.json','{"configured":true}');
 assert(diskWrites.some(x=>x.path.endsWith('obsidian-livesync/data.json')));
 app.metadataTypeManager={assignedWidgets:{CONFIDENTIAL_PROPERTY_NAME:{}},properties:{CONFIDENTIAL_PROPERTY_NAME:{}},rebuildProperties(){this.properties={...this.assignedWidgets};}};
 assert.equal(await plugin.lock(),true);
 assert.deepEqual(app.metadataTypeManager.properties,{});assert.equal(await a.exists('.obsidian/types.json'),false);
});

// Exact important TextFileView behaviour: save() is an already-resolved promise
// when saving=true, and the follow-up invoked in finally is deliberately unawaited.
async function nativeSavingFixture(t,failFollowup=false){
 const f=await fixture(t);await f.a.write('Native/A.md','before');
 let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const write=f.a.write;let calls=0;
 f.a.write=async(...args)=>{calls++;if(calls===1){entered();await held;}if(failFollowup&&calls>1)throw Error('follow-up failed');return write(...args);};
 const errors=[];
 const view={file:f.map.get('Native/A.md'),containerEl:{inert:false},saving:false,saveAgain:false,lastSavedData:'before',draft:'first-save',getViewData(){return this.draft;},getViewType:()=> 'markdown',
 async save(){
  if(this.saving){this.saveAgain=true;return;}
  this.saveAgain=false;const data=this.getViewData();if(this.lastSavedData===data)return;
  const old=this.lastSavedData;this.lastSavedData=data;this.saving=true;
  try{await f.a.write(this.file.path,data);}catch(e){this.lastSavedData=old;throw e;}
  finally{this.saving=false;if(this.saveAgain)this.save().catch(e=>errors.push(e));}
 }};
 let detached=false;f.leaves.push({view,detach(){detached=true;}});
 const first=view.save();await started;view.draft='newer-edit-while-saving';await view.save();
 const closing=f.plugin.lock();assert.equal(view.containerEl.inert,true);release();await first;
 return {...f,view,errors,result:await closing,isDetached:()=>detached};
}
test('lock waits for existing native save AND its unawaited newer follow-up',async t=>{
 const f=await nativeSavingFixture(t);
 assert.equal(f.result,true);assert(f.isDetached());assert.equal(f.errors.length,0);
 await f.plugin.store.unlock(password);assert.equal(await f.plugin.store.read('Native/A.md'),'newer-edit-while-saving');
});
test('failed native follow-up preserves editor draft and cancels lock',async t=>{
 const f=await nativeSavingFixture(t,true);
 assert.equal(f.result,false);assert.equal(f.isDetached(),false);assert(f.plugin.store.isUnlocked);assert(f.plugin.acceptWrites);
 assert.equal(f.view.containerEl.inert,false);assert.equal(f.view.draft,'newer-edit-while-saving');
 assert.equal(await f.plugin.store.read('Native/A.md'),'first-save');assert.equal(f.errors.length,1);
});

test('LiveSync binary ingress accepts encrypted envelopes and rejects plaintext or malformed bytes',async t=>{
 const {plugin,a,root}=await fixture(t);await a.write('Native/A.md','CONFIDENTIAL_BINARY_GUARD');
 const names=await fs.readdir(path.join(root,'CipherfoldStore'));
 for(const name of names){
  const p='CipherfoldStore/'+name;const before=await fs.readFile(path.join(root,p));
  await a.writeBinary(p,Uint8Array.from(before).buffer);
  assert.deepEqual(await fs.readFile(path.join(root,p)),before);
 }
 await assert.rejects(a.writeBinary('CipherfoldStore/vault.rvkey',new TextEncoder().encode('plaintext').buffer));
 await assert.rejects(a.writeBinary('CipherfoldStore/vault.rvkey',new Uint8Array([255,255]).buffer));
 await assert.rejects(a.writeBinary('outside.md',new TextEncoder().encode('plaintext').buffer));
 await plugin.lock();
 const p='CipherfoldStore/'+names.find(n=>n.endsWith('.renc'));
 const before=await fs.readFile(path.join(root,p));await a.writeBinary(p,Uint8Array.from(before).buffer);
 assert.equal(plugin.store.isUnlocked,false);
});

test('metadata reads cannot advance a dirty editor baseline; concurrent save becomes a retained branch',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','base');
 let draft='base';const view={file:map.get('Native/A.md'),getViewData:()=>draft,save:()=>a.write('Native/A.md',draft),getViewType:()=> 'markdown'};
 leaves.push({view,detach(){}});draft='local unsaved';
 const {VirtualStore}=await import('../src/virtual-store.mjs');const remote=new VirtualStore(plugin.raw);await remote.unlock(password);await remote.write('Native/A.md','remote branch');await plugin.refresh();
 assert.equal(await a.read('Native/A.md'),'remote branch'); // Metadata read sees latest, editor still refers to base.
 await a.write('Native/A.md',draft);const conflicts=plugin.store.conflicts();assert.equal(conflicts.length,2);
 assert.deepEqual(conflicts.map(r=>plugin.store.readRevision(r.objectId,r.revisionId)).sort(),['local unsaved','remote branch']);
 assert.equal(await plugin.verifyEditorSaved(view),true);
});

test('native setViewData refresh advances baseline only for authenticated current text',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','base');let data='base';
 const view={file:map.get('Native/A.md'),getViewData:()=>data,save:()=>a.write('Native/A.md',data),setViewData:value=>{data=value;}};
 leaves.push({view,detach(){}});const initial=plugin.editorBaselines.get(view).revisionId;
 const {VirtualStore}=await import('../src/virtual-store.mjs');const peer=new VirtualStore(plugin.raw);await peer.unlock(password);await peer.write('Native/A.md','remote');await plugin.refresh();
 view.setViewData('unsaved draft');assert.equal(plugin.editorBaselines.get(view).revisionId,initial);
 view.setViewData('remote');assert.equal(plugin.editorBaselines.get(view).revisionId,plugin.store.stat('Native/A.md').revisionId);
 data='real local edit';await a.write('Native/A.md',data);assert.equal(plugin.store.conflicts().length,0);assert.equal(await a.read('Native/A.md'),data);
});

test('saving an unchanged old editor after remote update does not create a false branch',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','base');let data='base';const view={file:map.get('Native/A.md'),getViewData:()=>data,save:()=>a.write('Native/A.md',data)};leaves.push({view,detach(){}});
 const {VirtualStore}=await import('../src/virtual-store.mjs');const peer=new VirtualStore(plugin.raw);await peer.unlock(password);await peer.write('Native/A.md','new remote');await plugin.refresh();
 const before=(await plugin.raw.list('CipherfoldStore')).files.length;await a.write('Native/A.md','base');assert.equal((await plugin.raw.list('CipherfoldStore')).files.length,before);assert.equal(plugin.store.conflicts().length,0);assert.equal(await a.read('Native/A.md'),'new remote');
});

test('native empty notebook creation and inline rename are persistent and selectable for a new note',async t=>{
 const {plugin,app,a,map}=await fixture(t);await a.mkdir('Native/New notebook');const folder=map.get('Native/New notebook');
 assert(folder?.children);await a.rename(folder.path,'Native/Named notebook');assert.equal(map.get('Native/Named notebook'),folder);assert(!map.has('Native/New notebook'));
 plugin.noteWorkflow.folder='Native/Named notebook';assert.equal(app.fileManager.fileParentCreatorByType.md('').path,'Native/Named notebook');
 await a.write('Native/Named notebook/A.md','first');assert.equal(await a.read('Native/Named notebook/A.md'),'first');
 await a.mkdir('Native/Empty');await plugin.lock();await plugin.store.unlock(password);plugin.acceptWrites=true;await plugin.publish();assert(map.has('Native/Empty'));
});
test('native projection creates implicit parents of a nested empty notebook in order',async t=>{
 const {plugin,app,a,map}=await fixture(t),seen=[],onChange=app.vault.onChange;
 app.vault.onChange=(event,path,...args)=>{if(event==='folder-created'){const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';if(parent)assert(map.has(parent));seen.push(path);}return onChange(event,path,...args);};
 await a.mkdir('Native/One/Two/Empty');assert.deepEqual(seen,['Native/One','Native/One/Two','Native/One/Two/Empty']);
 await plugin.lock();await plugin.store.unlock(password);plugin.acceptWrites=true;await plugin.publish();assert(map.has('Native/One/Two/Empty'));
});
test('native trash drains pending edits, hides the file, retains ciphertext and restores through the same object',async t=>{
 const {plugin,a,map,leaves,root}=await fixture(t);await a.write('Native/A.md','before');const file=map.get('Native/A.md'),identity=plugin.store.stat(file.path).objectId;
 const view={file,containerEl:{inert:false},draft:'pending edit before delete',getViewData(){return this.draft;},save(){return a.write(this.file.path,this.draft);}};leaves.push({view});
 const before=await fs.readdir(path.join(root,'CipherfoldStore'));await a.trashSystem('Native/A.md');assert(!map.has('Native/A.md'));assert(!plugin.store.exists('Native/A.md'));
 const deleted=plugin.store.deletedNotes()[0];assert.equal(deleted.objectId,identity);assert.equal(plugin.store.readRevision(identity,deleted.revisionId),'pending edit before delete');assert.equal(view.containerEl.inert,false);
 for(const name of before)assert(await plugin.raw.exists('CipherfoldStore/'+name));leaves.length=0;
 await plugin.store.restore(identity,deleted.revisionId,'Native/A.md');await plugin.publish();assert.equal(await a.read('Native/A.md'),'pending edit before delete');
});
test('remote delete defers removal of dirty editor, and its eventual save becomes an explicit conflict',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','before');const file=map.get('Native/A.md');
 const view={file,draft:'before',getViewData(){return this.draft;},save(){return a.write(this.file.path,this.draft);}};leaves.push({view});view.draft='local unsaved';
 await plugin.store.remove(file.path);await plugin.publish();assert.equal(map.get(file.path),file);assert.equal(view.draft,'local unsaved');
 await view.save();assert.equal(plugin.store.conflicts().length,2);assert(plugin.store.conflicts().some(r=>plugin.store.readRevision(r.objectId,r.revisionId)==='local unsaved'));
});
test('failed editor save blocks trash and normal recreation after deletion gets a distinct identity',async t=>{
 const {plugin,a,map,leaves}=await fixture(t);await a.write('Native/A.md','before');const file=map.get('Native/A.md'),old=plugin.store.stat(file.path).objectId;
 leaves.push({view:{file,getViewData:()=> 'unsaved',save:async()=>{throw Error('save failed');}}});await assert.rejects(a.trashLocal(file.path));assert.equal(await a.read(file.path),'before');assert.equal(plugin.store.deletedNotes().length,0);
 leaves.length=0;await a.remove(file.path);await a.write('Native/A.md','new');assert.notEqual(plugin.store.stat('Native/A.md').objectId,old);assert.equal(await a.read('Native/A.md'),'new');
});

test('native startup disables enabled File Recovery using current core-plugin lifecycle',async t=>{
 const {plugin,app}=await fixture(t,{recoveryEnabled:true});
 assert.equal(plugin.ready,true);assert.equal(app.internalPlugins.plugins['file-recovery'].enabled,false);
 assert.equal(await app.internalPlugins.plugins['file-recovery'].enable(),false);
});
