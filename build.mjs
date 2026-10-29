import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const modules=path.join(root,'node_modules');
const common=path.join(modules,'@vrtmrz/livesync-commonlib');
const native=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')).id==='cipherfold';
const alias=native?{
 crypto:path.join(root,'src/browser-webcrypto.mjs'),
 'replica-upstream/encryption':path.join(common,'dist/pouchdb/encryption.js'),
 'replica-upstream/path':path.join(common,'dist/string_and_binary/path.js'),
 'replica-upstream/id':path.join(common,'dist/common/idDerivation.js'),
 'replica-upstream/content':path.join(common,'dist/common/utils.js'),
 'replica-upstream/binary':path.join(modules,'octagonal-wheels/dist/binary/index.js'),
 '#worker':path.join(common,'dist/worker/bgWorker.direct.js'),
}:{};
const result=await build({absWorkingDir:root,entryPoints:['src/main.mjs'],outfile:'dist/main.js',write:false,metafile:true,bundle:true,alias,platform:'browser',format:'cjs',target:'es2022',external:['obsidian'],logLevel:'warning',plugins:native?[{
 name:'private-logger',setup(build){build.onLoad({filter:/octagonal-wheels\/dist\/common\/logger\.js$/},async(args)=>{
 const source=await fs.readFile(args.path,'utf8');
 // Keep upstream constants/API but never serialize private objects to console.
 return {contents:source.replace(/const defaultLogger = function defaultLogger[\s\S]*?\n};/, 'const defaultLogger = function defaultLogger() {};'),loader:'js'};
 });}
}]:[]});
const packages=new Map();
for(const input of Object.keys(result.metafile.inputs)){
 if(!input.startsWith('node_modules/'))continue;
 let dir=path.dirname(path.join(root,input));
 while(dir.startsWith(modules)){
  try{const p=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
   if(p.name&&p.version){packages.set(p.name+'@'+p.version,{dir,p});break;}
  }catch{} dir=path.dirname(dir);
 }
}
let notices='# Third-party notices\n\nLicenses for packages included in the generated runtime bundle. Development-only dependencies are recorded in package-lock.json.\n';
for(const [id,{dir,p}] of [...packages].sort(([a],[b])=>a.localeCompare(b))){
 const file=(await fs.readdir(dir)).find(f=>/^licen[sc]e(?:\..*)?$/i.test(f));
 if(!file)throw Error('Missing license: '+id);
 notices+='\n## '+id+' ('+p.license+')\n\n'+(await fs.readFile(path.join(dir,file),'utf8')).trim()+'\n';
}
await fs.mkdir(path.join(root,'dist'),{recursive:true});
await fs.writeFile(path.join(root,'THIRD-PARTY-NOTICES.md'),notices);
await fs.writeFile(path.join(root,'dist/main.js'),'/*!\n'+notices.replaceAll('*/','* /')+'\n*/\n'+result.outputFiles[0].text);
for(const name of ['manifest.json','styles.css'])await fs.copyFile(path.join(root,name),path.join(root,'dist',name));
console.log('Built '+(native?'Cipherfold':'Dictation Bridge')+' with '+packages.size+' bundled dependency licenses');
