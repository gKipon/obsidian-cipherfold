const native = path => typeof path === 'string' && (path === 'Native' || path.startsWith('Native/'));
const fail = (code, message) => {const error = new Error(message); error.code = code; throw error;};
const editableViews = (plugin, path) => {
  const result = [];
  plugin.app.workspace.iterateAllLeaves(leaf => {
    const view = leaf.view;
    if (view?.file?.path === path && typeof view.save === 'function' && typeof view.getViewData === 'function') result.push(view);
  });
  return result;
};
const folderOf = file => file?.children ? file : file?.parent;

export function installNoteWorkflow(plugin, Notice) {
  const {app} = plugin, {vault, workspace, fileManager} = app;
  const state = plugin.noteWorkflow = {folder:null, renameQueue:Promise.resolve(), renames:0, lockRequested:false};
  const ready = () => {
    if (!plugin.acceptWrites || !plugin.store.isUnlocked || plugin.disposed || plugin.lockPromise || state.lockRequested)
      fail('LOCKED', 'Cipherfold: unlock encrypted notes first.');
  };
  if (typeof vault.getAvailablePath === 'function') {
    const original = vault.getAvailablePath;
    const normalize = path => path.normalize('NFC').toLowerCase();
    const available = function(base, extension) {
      if (!native(base)) return original.call(this, base, extension);
      ready();
      const files = new Set(plugin.store.reservedPaths().map(normalize));
      const reserved = new Set([...files,...plugin.store.listFolders().map(normalize)]);
      for (const file of files) {
        const parts = file.split('/'); parts.pop();
        while (parts.length > 1) {reserved.add(parts.join('/')); parts.pop();}
      }
      // Suffixing the leaf cannot fix a parent which is itself an archived file.
      const parents = normalize(base).split('/'); parents.pop();
      while (parents.length > 1) {
        if (files.has(parents.join('/'))) fail('STORE_CONFLICT', 'Cipherfold: this archive name belongs to a file. Choose another notebook.');
        parents.pop();
      }
      const limit = reserved.size + vault.getAllLoadedFiles().length;
      for (let n = 0; n <= limit; n++) {
        const candidate = base + (n ? ' ' + n : '') + (extension ? '.' + extension : '');
        if (!reserved.has(normalize(candidate)) && !vault.getAbstractFileByPathInsensitive(candidate)) return candidate;
      }
      fail('STORE_CAPACITY', 'Cipherfold: unable to find an available name.');
    };
    vault.getAvailablePath = available;
    plugin.register(() => {if (vault.getAvailablePath === available) vault.getAvailablePath = original;});
  }
  const remember = file => {const folder = folderOf(file); if (native(folder?.path)) state.folder = folder.path;};
  remember(workspace.getActiveFile?.());
  // The explorer toolbar creates folders at the physical root, independently
  // of getNewFileParent. Keep its normal naming/inline rename inside Native.
  if (typeof fileManager?.createNewFolder === 'function') {
    const original = fileManager.createNewFolder;
    const create = function(parent) {
      ready();
      const target = native(parent?.path) ? parent : vault.getAbstractFileByPath('Native');
      if (!target?.children) fail('LOCKED', 'Cipherfold: unlock encrypted notes first.');
      return original.call(this, target);
    };
    fileManager.createNewFolder = create;
    plugin.register(() => {if (fileManager.createNewFolder === create) fileManager.createNewFolder = original;});
  }
  if (fileManager?.registerFileParentCreator) {
    fileManager.registerFileParentCreator('md', sourcePath => {
      ready();
      const source = folderOf(sourcePath ? vault.getAbstractFileByPath(sourcePath) : null);
      // A link created from another source note keeps that source's notebook.
      if (sourcePath && sourcePath !== workspace.getActiveFile?.()?.path && native(source?.path)) return source;
      for (const leaf of workspace.getLeavesOfType?.('file-explorer') || []) {
        const view = leaf.view;
        if (view.containerEl?.contains(globalThis.document?.activeElement)) {
          const focused = folderOf(view.tree?.focusedItem?.file);
          if (native(focused?.path)) return focused;
        }
      }
      const current = state.folder ? vault.getAbstractFileByPath(state.folder) : null;
      return (current?.children && native(current.path) ? current : native(source?.path) ? source : null)
        || vault.getAbstractFileByPath('Native');
    });
    // Reapply on startup; config writes remain under the existing RAM-only guard.
    vault.setConfig?.('newFileLocation', 'current');
    if (workspace.on) plugin.registerEvent(workspace.on('file-open', remember));
    plugin.registerDomEvent(document, 'pointerdown', event => {
      const title = event.target?.closest?.('.nav-folder-title[data-path]');
      if (title?.closest('.workspace-leaf-content[data-type="file-explorer"]')) {
        const folder = vault.getAbstractFileByPath(title.getAttribute('data-path'));
        if (folder?.children && native(folder.path)) state.folder = folder.path;
      }
    }, true); // File explorer consumes pointer events; observe before its handlers.
  }
  plugin.adapter.rename = (from, to) => {
    const operation = async () => {
      ready();
      if (!native(from) || !native(to)) fail('INVALID_PATH', 'Cipherfold: notes can only move within Native.');
      const folder=plugin.store.stat(from)?.type==='folder';
      if (!folder&&(!/\.md$/i.test(from) || !/\.md$/i.test(to))) fail('UNSUPPORTED_OPERATION', 'Cipherfold: only Markdown notes or empty notebooks can be renamed.');
      const occupied = vault.getAbstractFileByPath(to);
      if (occupied && occupied !== vault.getAbstractFileByPath(from))
        fail('STORE_CONFLICT', 'Cipherfold: that name is already occupied.');
      const views = editableViews(plugin, from), inert = views.map(view => [view.containerEl, view.containerEl?.inert]);
      for (const [el] of inert) if (el) el.inert = true;
      try {
        if (new Set(views.map(view => view.getViewData())).size > 1)
          fail('DIVERGENT_EDITORS', 'Cipherfold: open tabs contain different edits. Reconcile them before renaming.');
        for (const view of views) {await plugin.settleView(view); await view.save(); await plugin.settleView(view);}
        await plugin.queue;
        const snapshots = views.map(view => [view, view.getViewData()]);
        for (const [, data] of snapshots) if (await plugin.store.read(from) !== data)
          fail('UNSAVED_DRAFT', 'Cipherfold: save the note first. Rename cancelled.');
        await plugin.run(async () => {
          if (!plugin.acceptWrites || !plugin.store.isUnlocked || plugin.disposed) fail('LOCKED', 'Cipherfold: vault is locked.');
          if (snapshots.some(([view, data]) => view.saving || view.getViewData() !== data))
            fail('UNSAVED_DRAFT', 'Cipherfold: text changed while saving. Retry renaming.');
          plugin.validateSync(); await plugin.store.rename(from, to);
          if(folder&&vault.getAbstractFileByPath(from)&&!vault.getAbstractFileByPath(from).children?.length)vault.onChange('renamed',to,from);
          await plugin.publish();
          for(const view of views)plugin.captureEditor?.(view,view.file);
          void plugin.syncReplica?.({quiet:true});
        });
        remember(vault.getAbstractFileByPath(to));
      } finally {for (const [el, previous] of inert) if (el) el.inert = previous;}
    };
    state.renames++;
    const result = state.renameQueue.then(operation).catch(error => {
      const messages = {STORE_CONFLICT:'Cipherfold: name occupied or conflicting revisions exist. Choose another name.',
        STALE_REVISION:'Cipherfold: another device changed this note. Refresh before renaming.',
        NOT_FOUND:'Cipherfold: note no longer exists at its former name.'};
      const message = messages[error.code] || (['LOCKED','INVALID_PATH','UNSUPPORTED_OPERATION','DIVERGENT_EDITORS','UNSAVED_DRAFT'].includes(error.code)
        ? error.message : 'Cipherfold: rename was not saved. Original history retained; verify and retry.');
      new Notice(message); fail(error.code || 'RENAME_FAILED', message);
    }).finally(() => {state.renames--;});
    state.renameQueue = result.catch(() => {});
    return result;
  };
  const removeNote = path => {
    state.renames++;
    const result=state.renameQueue.then(async()=>{
      ready();if(!native(path)||!plugin.store.stat(path)||plugin.store.stat(path).type!=='file'||!/\.md$/i.test(path))
        fail('UNSUPPORTED_OPERATION','Cipherfold: only individual Markdown notes can be moved to trash.');
      const views=editableViews(plugin,path),inert=views.map(v=>[v.containerEl,v.containerEl?.inert]);
      for(const [el]of inert)if(el)el.inert=true;
      try{
        if(new Set(views.map(v=>v.getViewData())).size>1)fail('DIVERGENT_EDITORS','Cipherfold: reconcile open tabs first.');
        for(const view of views){await plugin.settleView(view);await view.save();await plugin.settleView(view);}
        await plugin.queue;
        const snapshots=views.map(v=>[v,v.getViewData()]);
        for(const [,text]of snapshots)if(await plugin.store.read(path)!==text)fail('UNSAVED_DRAFT','Cipherfold: save the text first.');
        await plugin.run(async()=>{
          if(!plugin.acceptWrites||!plugin.store.isUnlocked||snapshots.some(([v,text])=>v.saving||v.getViewData()!==text))fail('UNSAVED_DRAFT','Cipherfold: text changed; trash operation cancelled.');
          plugin.validateSync();await plugin.store.remove(path);await plugin.publish();void plugin.syncReplica?.({quiet:true});
        });
        new Notice('Cipherfold: note moved to encrypted trash. Use the Trash: restore a note command to recover it.');
      }finally{for(const [el,value]of inert)if(el)el.inert=value;}
    }).catch(e=>{new Notice('Cipherfold: trash operation failed. History and unsaved text retained.');throw e;}).finally(()=>{state.renames--;});
    state.renameQueue=result.catch(()=>{});return result;
  };
  plugin.adapter.remove=removeNote;
  plugin.adapter.trashLocal=removeNote;
  plugin.adapter.trashSystem=async path=>{await removeNote(path);return true;};
  const lock = plugin.lock.bind(plugin);
  plugin.lock = async () => {
    state.lockRequested = true;
    try {if (state.renames) await state.renameQueue; const closed = await lock(); if (closed) state.folder = null; return closed;}
    finally {state.lockRequested = false;}
  };
}

/** Preserve TFile identity on rename so editors, tabs and native link updates
 * follow the same note. Ciphertext UUID filenames never change. */
export async function publishNative(plugin) {
  if (!plugin.store.isUnlocked) return;
  const files = plugin.store.listFiles(), vault = plugin.app.vault;
  const folders = new Set(['Native', ...plugin.store.listFolders()]);
  for (const path of [...folders,...files.map(file=>file.path)]) {const parts = path.split('/'); while (parts.length > 1) {parts.pop(); folders.add(parts.join('/'));}}
  for (const folder of [...folders].sort((a,b) => a.split('/').length - b.split('/').length))
    if (!vault.getAbstractFileByPath(folder)) vault.onChange('folder-created', folder);
  const byIdentity = new Map([...plugin.projected.values()].map(file => [file.objectId, file]));
  const visibleObjects=new Set(files.map(f=>f.objectId));
  for(const previous of [...plugin.projected.values()])if(!visibleObjects.has(previous.objectId)){
    if(plugin.canRemoveRevision&&!plugin.canRemoveRevision(previous))continue;
    const old=vault.getAbstractFileByPath(previous.path);old?.cache?.(null);
    if(old)vault.onChange('file-removed',previous.path);
    plugin.projected.delete(previous.path);
  }
  for (const file of files) {
    const previous = byIdentity.get(file.objectId), stat = {ctime:file.ctime, mtime:file.mtime, size:file.size};
    if(plugin.canPublishRevision&&!plugin.canPublishRevision(file,previous))continue;
    const occupied=plugin.projected.get(file.path);if(occupied&&occupied.objectId!==file.objectId)continue;
    if (previous && previous.path !== file.path && vault.getAbstractFileByPath(previous.path)) {
      if (vault.getAbstractFileByPath(file.path)) fail('STORE_CONFLICT', 'Cipherfold: new name occupied; refresh stopped.');
      vault.onChange('renamed', file.path, previous.path);
      plugin.projected.delete(previous.path);
    }
    if (!vault.getAbstractFileByPath(file.path)) vault.onChange('file-created', file.path, undefined, stat);
    else if (previous?.revisionId !== file.revisionId) vault.onChange('modified', file.path, undefined, stat);
    plugin.projected.set(file.path, file);
  }
  for(const f of vault.getAllLoadedFiles().filter(f=>f.children&&native(f.path)&&!folders.has(f.path)).sort((a,b)=>b.path.length-a.path.length)){
    if(!f.children.length)vault.onChange('folder-removed',f.path);
  }
}
