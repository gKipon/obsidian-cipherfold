import {validateReplicaEntries} from './crypto.mjs';
import {embeddedTargets} from './resource-cache.mjs';
export const canonical = v => Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : v!==null && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);
export function requireReplica(value, code='REPLICA_INVALID') { if(!value){const e=Error(code);e.code=code;throw e;} }
export const recordPath = e => `CipherfoldStore/${e.objectId}_${e.revisionId}.renc`;
export function attachmentDependencies(record, records) {
  if(record.kind!=='note')return [];
  const attachments=records.filter(r=>r.kind==='attachment'), result=new Set();
  const normal=value=>{const parts=[];for(const p of value.split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}return parts.join('/');};
  for(const link of embeddedTargets(record.body)){
    const candidates=[link,'Native/'+link,normal(record.name.slice(0,record.name.lastIndexOf('/')+1)+link)];
    let matches=attachments.filter(r=>candidates.includes(r.name));
    if(!matches.length)matches=attachments.filter(r=>r.name.endsWith('/'+link));
    const objects=new Set(matches.map(r=>r.objectId));
    // Include every ambiguous attachment, never silently drop a media dependency.
    for(const id of objects)result.add(id);
  }
  return [...result].sort();
}
export function descriptor(record, {sha256,ciphertextBytes}, records) {
  const {body,byteLength:retainedLength,...metadata}=record;
  const byteLength=retainedLength ?? (record.kind==='note'?new TextEncoder().encode(body).length:body.length/4*3-(body.endsWith('==')?2:body.endsWith('=')?1:0));
  return validateReplicaEntries([{...metadata,byteLength,attachments:attachmentDependencies(record,records),sha256,ciphertextBytes}])[0];
}
export function mergeEntries(...sets) {
  const merged=new Map();
  for(const entries of sets)for(const e of validateReplicaEntries(entries)){
    const prev=merged.get(e.revisionId);
    requireReplica(!prev||canonical(prev)===canonical(e),'CATALOGUE_EQUIVOCATION');
    merged.set(e.revisionId,structuredClone(e));
  }
  return [...merged.values()].sort((a,b)=>a.revisionId.localeCompare(b.revisionId));
}
export function heads(entries) {
  const parents=new Set(entries.flatMap(e=>e.parents));return entries.filter(e=>!parents.has(e.revisionId));
}
