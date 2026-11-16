/** Separate persistent acceptance workspace. Never restarts or copies the production workspace. */
import {spawn} from 'node:child_process';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),operation=process.argv[2]||'start';
if(!['start','status','stop'].includes(operation)||process.argv.length>3)throw Error('使用 npm run acceptance -- start|status|stop');
const storage=resolve(process.env.CQFORGE_ACCEPTANCE_STORAGE||resolve(root,'local-runs/acceptance-v02')),
  production=resolve(process.env.CQFORGE_STORAGE||resolve(root,'local-runs/workbench'));
if(storage===production)throw Error('验收目录不能与正式工作空间相同');
const env={...process.env,CQFORGE_STORAGE:storage,CQFORGE_PORT:process.env.CQFORGE_ACCEPTANCE_PORT||'4318',CQFORGE_ACCEPTANCE:'1'};
// Model credentials must be entered in this workspace's UI; never inherit production's credential environment.
for(const key of ['CQFORGE_API_KEY','CQFORGE_MODEL_URL','CQFORGE_MODEL_NAME','CQFORGE_ALLOW_INSECURE_HTTP'])delete env[key];
const child=spawn(process.execPath,[resolve(root,'web/manage.mjs'),operation],{cwd:root,env,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('无法启动验收管理程序\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code||0;if(code===0&&operation==='start')process.stdout.write('验收地址：http://127.0.0.1:'+env.CQFORGE_PORT+' · 独立数据目录；请在页面连接模型。\n');});
