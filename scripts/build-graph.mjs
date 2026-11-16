import {build} from 'esbuild';
import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const result=await build({absWorkingDir:root,entryPoints:['web/graph-view.mjs','web/graph-fa2-worker-v1.mjs'],outdir:'web/assets',outExtension:{'.js':'.mjs'},
  bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',metafile:true,write:false,
  banner:{js:'/*! OntoWeave graph view. Third-party license texts: ./THIRD_PARTY_LICENSES.txt */'}});
const packages=new Set();
for(const path of Object.keys(result.metafile.inputs)){const part=path.split('node_modules/')[1];if(part)packages.add(part.startsWith('@')?part.split('/').slice(0,2).join('/'):part.split('/')[0]);}
let notices='OntoWeave graph bundle — third-party licenses. Generated from installed locked dependencies.\n';
for(const name of [...packages].sort()){
  const folder=resolve(root,'node_modules',name),p=JSON.parse(readFileSync(resolve(folder,'package.json'),'utf8'));
  if(!['MIT','ISC','Apache-2.0'].includes(p.license))throw Error('未审查的图谱依赖许可：'+name+' '+p.license);
  let license;for(const file of ['LICENSE','LICENSE.txt','LICENSE.md','License','LICENSE.MIT']){try{license=readFileSync(resolve(folder,file),'utf8');break;}catch{}}
  if(!license)throw Error('缺少完整第三方许可：'+name);
  notices+='\n\n=== '+name+' '+p.version+' ('+p.license+') ===\n'+license;
}
// Finish every license check before replacing any served artifact. No network at build/start time.
mkdirSync(resolve(root,'web/assets'),{recursive:true});
const files=[{path:resolve(root,'web/assets/THIRD_PARTY_LICENSES.txt'),contents:notices},...result.outputFiles];
const staged=files.map(file=>{const temporary=file.path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,file.contents);return {temporary,path:file.path};});
for(const file of staged)renameSync(file.temporary,file.path);
console.log('Graph bundle built locally; '+packages.size+' dependency licenses retained.');

// All product entry points already await this local build before serving UI.
await import('./build-lightog-chat-markdown-v1.mjs');
