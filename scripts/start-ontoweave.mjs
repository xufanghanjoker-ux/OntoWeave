#!/usr/bin/env node
/** Public source entry: no dependency on a private release.json. */
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),runtimeFile=join(root,'.ontoweave/runtime.json');
const pgConfig=process.env.ONTOWEAVE_PG_CONFIG;
if (pgConfig) {
  const config=JSON.parse(readFileSync(resolve(pgConfig),'utf8'));
  const webPort=Number(config.web_port);
  if (!Number.isInteger(webPort) || webPort<1024 || webPort>65535) throw Error('ONTOWEAVE_WEB_PORT_INVALID');
  const {createPGWorkbench}=await import('../web/server.mjs');
  const server=createPGWorkbench(config,process.env.ONTOWEAVE_PG_WRITE_TOKEN);
  server.listen(webPort,'127.0.0.1',()=>console.log(`OntoWeave PG http://127.0.0.1:${webPort}`));
} else {
if(!existsSync(runtimeFile))throw Error('Run npm run setup:runtime -- --codex=/absolute/path/to/codex first.');
const runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));
process.env.ONTOWEAVE_CODEX_EXECUTABLE=runtime.executable;
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_FILE=runtime.lock_file;
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_SHA256=runtime.lock_sha256;
process.env.CQFORGE_STORAGE??=resolve(root,'.ontoweave/workspace');
process.env.CQFORGE_PORT??='4332';
const core=resolve(process.env.ONTOWEAVE_CORE_BINARY??join(root,'target/debug/lightog-core'));
if(!existsSync(core))throw Error('Run cargo build --locked -p lightog-core first.');
const expectedCoreSha256=createHash('sha256').update(readFileSync(core)).digest('hex');
await import('./build-graph.mjs');
const {startWorkbench}=await import('../web/server.mjs');
await startWorkbench({sourceFirstOptions:{coreBinary:core,expectedCoreSha256,mainProduct:true,automaticExecution:true,candidateMvpDefault:true,localResolutionDefault:true,fineAnswerCitations:true,documentTemporalPublication:true,nativeFullChain:{defaultBuildFlowPolicy:'SIMPLIFIED_SOURCE_BLOCK_V1'}}});
}
