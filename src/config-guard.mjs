// Plugin activation contains installed identifiers only, never note metadata.
// Persisting it lets the user's disable choice survive a full restart.
export function isPluginEnablement(app,data){
  if(typeof data!=='string'||data.length>65536)return false;
  try{
    const ids=JSON.parse(data),manifests=app.plugins?.manifests??{};
    return Array.isArray(ids)&&ids.length<=512&&new Set(ids).size===ids.length&&
      ids.every(id=>typeof id==='string'&&/^[a-z0-9_-]{1,128}$/.test(id)&&Object.hasOwn(manifests,id));
  }catch{return false;}
}
