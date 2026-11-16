#!/usr/bin/env node
/** Local protocol preparation only. No model calls or credentials. */
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.ontoweave');
const option=process.argv.find(v=>v.startsWith('--codex='))?.slice(8);
const located=spawnSync('which',['codex'],{encoding:'utf8'});
const candidate=option??process.env.ONTOWEAVE_CODEX_EXECUTABLE??located.stdout?.trim();
if(!candidate||!existsSync(candidate))throw Error('Set ONTOWEAVE_CODEX_EXECUTABLE to an installed Codex executable, or pass --codex=/absolute/path.');
const executable=resolve(candidate),version=spawnSync(executable,['--version'],{encoding:'utf8'});
if(version.status!==0)throw Error('Codex --version failed');
const cliVersion=version.stdout.trim().replace(/^codex-cli\s+/,'');
if(cliVersion!=='0.169.0-alpha.11.1')throw Error(`Untested Codex version ${cliVersion}; this Alpha was validated with 0.169.0-alpha.11.1. Do not bypass the protocol lock.`);
mkdirSync(out,{recursive:true});
const schemaDir=join(out,'protocol-schemas');
const generated=spawnSync(executable,['app-server','generate-json-schema','--out',schemaDir],{encoding:'utf8',timeout:60000});
if(generated.status!==0)throw Error('Codex protocol generation failed: '+generated.stderr);
const names=['v1/InitializeParams.json','v1/InitializeResponse.json','v2/ThreadStartParams.json','v2/ThreadStartResponse.json','v2/TurnStartParams.json','v2/TurnStartResponse.json','v2/TurnInterruptParams.json','v2/TurnInterruptResponse.json','v2/TurnCompletedNotification.json','v2/ThreadTokenUsageUpdatedNotification.json'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const lock={version:'lightog-codex-protocol-lock/1',cli_version:cliVersion,executable_sha256:sha(readFileSync(executable)),schemas:Object.fromEntries(names.map(n=>[n,sha(readFileSync(join(schemaDir,n)))]))};
writeFileSync(join(out,'runtime-lock.json'),JSON.stringify(lock,null,2)+'\n',{mode:0o600});
writeFileSync(join(out,'runtime.json'),JSON.stringify({executable,lock_file:join(out,'runtime-lock.json'),lock_sha256:sha(readFileSync(join(out,'runtime-lock.json')))},null,2)+'\n',{mode:0o600});
console.log('OntoWeave local Codex runtime prepared. No model requests sent.');
