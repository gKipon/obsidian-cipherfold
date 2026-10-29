// A baseline belongs to the editor that loaded it, never to metadata/search reads.
// Obsidian's adapter API does not identify the calling pane: keep one editable
// pane per note, and reject ambiguous callers instead of guessing an author.
export function installEditorRevisions(plugin){
  plugin.editorBaselines=new WeakMap();
  const views=path=>{const result=[];plugin.app.workspace.iterateAllLeaves(leaf=>{const v=leaf.view;if(v?.file?.path===path&&typeof v.getViewData==='function'&&typeof v.save==='function')result.push(v);});return result;};
  plugin.editorViews=views;
  plugin.captureEditor=(view,file)=>{
    const stat=plugin.store.stat(file.path);if(!stat||stat.binary||typeof view?.getViewData!=='function')return;
    plugin.editorBaselines.set(view,{...stat,body:view.getViewData()});
    if(typeof view.setViewData==='function'&&!view.__cipherfoldRevisionGuard){
      const original=view.setViewData.bind(view);view.__cipherfoldRevisionGuard=true;
      view.setViewData=(data,...args)=>{
        const result=original(data,...args);
        const capture=()=>{
          if(plugin.store.isUnlocked&&view.file&&typeof data==='string'){
            const current=plugin.store.stat(view.file.path);
            if(current&&!current.binary&&plugin.store.readRevision(current.objectId,current.revisionId)===data&&view.getViewData()===data)
              plugin.editorBaselines.set(view,{...current,body:data});
          }
        };
        if(result&&typeof result.then==='function')return result.then(value=>{capture();return value;});
        capture();return result;
      };
    }
  };
  plugin.editorWriteOptions=path=>{
    const editors=views(path);if(!editors.length)return {expectedRevisionId:plugin.store.stat(path)?.revisionId??null};
    const baselines=editors.map(v=>plugin.editorBaselines.get(v));
    if(editors.length!==1||!baselines[0])throw Object.assign(Error('EDITOR_BASELINE'),{code:'EDITOR_BASELINE'});
    return {expectedRevisionId:baselines[0].revisionId};
  };
  plugin.saveEditorText=async(path,body)=>{
    const options=plugin.editorWriteOptions(path);let saved;
    const editor=views(path)[0],baseline=editor&&plugin.editorBaselines.get(editor);
    if(baseline&&baseline.body===body&&plugin.store.readRevision(baseline.objectId,baseline.revisionId)===body)return baseline;
    try{saved=await plugin.store.write(path,body,options);}
    catch(e){
      if(!['STALE_REVISION','STORE_CONFLICT'].includes(e.code)||!options.expectedRevisionId)throw e;
      saved=await plugin.store.saveBranch(path,body,options.expectedRevisionId);
    }
    for(const v of views(path))plugin.editorBaselines.set(v,{...saved,body});
    return saved;
  };
  plugin.canPublishRevision=(file,previous)=>{
    if(!previous||previous.revisionId===file.revisionId)return true;
    for(const view of views(previous.path)){
      const baseline=plugin.editorBaselines.get(view);
      if(baseline&&baseline.revisionId!==file.revisionId&&(view.saving||view.getViewData()!==baseline.body))return false;
    }
    return true;
  };
  plugin.canRemoveRevision=previous=>views(previous.path).every(view=>{
    const baseline=plugin.editorBaselines.get(view);
    return baseline&&!view.saving&&view.getViewData()===baseline.body;
  });
  plugin.verifyEditorSaved=async view=>{
    const baseline=plugin.editorBaselines.get(view);
    if(baseline)return plugin.store.readRevision(baseline.objectId,baseline.revisionId)===view.getViewData();
    return await plugin.store.read(view.file.path)===view.getViewData();
  };
}
