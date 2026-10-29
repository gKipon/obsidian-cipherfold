/** Bounded, session-only media URLs. No Blob, cache or file writes. */
export class ResourceCache {
  #items=new Map();#pending=new Map();#generation=0;#bytes=0;
  constructor(load,{maxBytes=96*1024*1024}={}){this.load=load;this.maxBytes=maxBytes;}
  get bytes(){return this.#bytes;}
  get(path){const hit=this.#items.get(path);if(!hit)return;this.#items.delete(path);this.#items.set(path,hit);return hit.url;}
  async ensure(path){
    if(this.#items.has(path))return this.get(path);
    if(this.#pending.has(path))return this.#pending.get(path);
    const generation=this.#generation;
    const task=(async()=>{
      const result=await this.load(path);
      if(generation!==this.#generation)return;
      if(!result||result.bytes>this.maxBytes||result.bytes<0)throw Error('Attachment cache limit');
      while(this.#bytes+result.bytes>this.maxBytes&&this.#items.size){const oldest=this.#items.keys().next().value;this.#bytes-=this.#items.get(oldest).bytes;this.#items.delete(oldest);}
      this.#items.set(path,result);this.#bytes+=result.bytes;return result.url;
    })().finally(()=>{if(generation===this.#generation)this.#pending.delete(path);});
    this.#pending.set(path,task);return task;
  }
  clear(){this.#generation++;this.#items.clear();this.#pending.clear();this.#bytes=0;}
}
export function embeddedTargets(markdown){
  const targets=[];
  for(const m of markdown.matchAll(/!\[\[([^\]\n]+)\]\]/g))targets.push(m[1].split('|')[0].split('#')[0]);
  for(const m of markdown.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g))targets.push(m[1]||m[2]);
  return [...new Set(targets.map(x=>{try{return decodeURIComponent(x);}catch{return x;}}))].filter(x=>x&&!/^[a-z][a-z0-9+.-]*:/i.test(x));
}
