/** Explicit local lifecycle commands. No OS autostart and no credential files. */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, cpSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { project, supportedNode, parserPython, doctor, cleanParserEnv } from './runtime.mjs';
const command = process.argv[2], storage = resolve(process.env.CQFORGE_STORAGE || resolve(project, 'local-runs/workbench'));
const port = Number(process.env.CQFORGE_PORT || 4317), marker = resolve(storage, 'server.json');
if (!supportedNode()) throw Error('需要 Node 22.22+ 或 24.15+（只支持这两条偶数版本线）：https://nodejs.org/en/download');
const run = (binary, args, env = process.env) => new Promise((done, reject) => {
  const child = spawn(binary, args, { cwd: project, env, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(Error('步骤失败（退出码 ' + code + '）；未报告初始化成功，请修复后重试')));
});
async function owned() {
  if (!existsSync(marker)) throw Error('没有本工程的后台运行记录；不会操作其他进程');
  const saved = JSON.parse(readFileSync(marker));
  const response = await fetch('http://127.0.0.1:' + saved.port + '/api/health', { signal: AbortSignal.timeout(3000) });
  const live = await response.json();
  if (live.instance !== saved.instance || live.pid !== saved.pid || live.storage !== storage) throw Error('进程身份不匹配；不会停止端口占用者');
  return { saved, live };
}
if (command === 'doctor') {
  const { createStore } = await import('./store.mjs');
  const report = doctor({ storage });
  if (existsSync(resolve(storage, 'cqforge.sqlite'))) {
    const store = createStore(storage);
    report.sqlite = store.db.prepare('PRAGMA integrity_check').get(); report.attachments = store.verifyArtifacts();
    report.model = { configured: Boolean(store.getSetting('model')?.model), key: 'NOT_CHECKED_OR_READ' }; store.close();
  } else report.sqlite = { status: 'NOT_INITIALIZED' };
  try { report.server = (await owned()).live; } catch { report.server = { status: 'NOT_MANAGED_OR_NOT_RUNNING' }; }
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'setup') {
  console.log('初始化将联网安装项目专用 Python 3.12 依赖，并下载布局、表格、OCR 权重（macOS 至少预留 4GB，Linux 默认 PyTorch 包可能需要 12GB 以上）；模型权重许可需在发布前核对。仅使用合成 PDF/DOCX，不发送业务资料到生成模型。');
  if (!process.argv.includes('--yes')) {
    if (!process.stdin.isTTY) throw Error('请在终端确认，或明确传入 npm run setup:parser -- --yes');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yes = await rl.question('继续？输入 yes：'); rl.close(); if (yes !== 'yes') process.exit(0);
  }
  process.umask(0o077);
  const stateDirectory = resolve(project, '.ontoweave');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stateDirectory);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw Error('Use an owner-only .ontoweave directory (mode 0700).');
  }
  const manifestPath = resolve(project, '.ontoweave/setup-manifest.json');
  const prior = doctor({ storage }).parser;
  const state = { status: 'PREPARING', at: new Date().toISOString() };
  const save = () => writeFileSync(manifestPath, JSON.stringify(state, null, 2), { mode: 0o600 }); save();
  try {
    if (!existsSync(parserPython())) {
      const py = process.platform === 'win32' ? 'py' : 'python3.12', prefix = process.platform === 'win32' ? ['-3.12'] : [];
      const check = spawnSync(py, [...prefix, '-c', 'import sys;assert sys.version_info[:2]==(3,12)']);
      if (check.status !== 0) throw Error('需要自行安装 Python 3.12：https://www.python.org/downloads/；不会改写系统 Python');
      await run(py, [...prefix, '-m', 'venv', resolve(project, '.venv-docling312')]);
    }
    const versionCheck = spawnSync(parserPython(), ['-c', 'import sys;assert sys.version_info[:2]==(3,12)']);
    if (versionCheck.status !== 0) throw Error('项目解析环境必须使用Python3.12；请按官方指引安装，不自动改写现有解释器');
    await run(parserPython(), ['-m', 'pip', 'install', '-r', 'web/requirements-docling.lock']);
    await run(parserPython(), ['-m', 'pip', 'install', '-r', 'web/requirements-hybrid-chunking.lock']);
    const tokenizerCache=resolve(project,'.ontoweave/docling-models/tiktoken');
    mkdirSync(tokenizerCache,{recursive:true});
    await run(parserPython(), ['-c', 'import tiktoken; tiktoken.get_encoding("cl100k_base")'], {...cleanParserEnv(),TIKTOKEN_CACHE_DIR:tokenizerCache});
    const env = cleanParserEnv(); delete env.HF_HUB_OFFLINE;
    if (process.env.HF_ENDPOINT) env.HF_ENDPOINT = process.env.HF_ENDPOINT;
    await run(parserPython(), ['web/setup_parser.py'], cleanParserEnv());
    state.status = 'VERIFYING'; save();
    try {
      if (prior.status === 'CORRUPT_CACHE') throw Error('模型缓存哈希已变化，需重新下载验证');
      await run(process.execPath, ['web/parser-smoke.mjs'], { ...process.env, HF_HUB_OFFLINE: '1' });
    }
    catch {
      console.log('缓存离线验收未通过，尝试下载缺失权重；不会关闭 HTTPS 校验。');
      state.status = 'DOWNLOADING'; save();
      await run(parserPython(), ['web/setup_parser.py', '--download', ...(prior.status === 'CORRUPT_CACHE' ? ['--force'] : [])], env);
      state.status = 'VERIFYING'; save();
      await run(process.execPath, ['web/parser-smoke.mjs'], { ...process.env, HF_HUB_OFFLINE: '1' });
    }
    state.files = [];
    function scan(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) scan(path);
      else if (item.isFile() && !item.name.endsWith('.lock') && !item.name.endsWith('.incomplete')) {
        state.files.push({ path: relative(project, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      }
    } }
    scan(resolve(project, '.ontoweave/docling-models'));
    if (!state.files.length) throw Error('模型缓存为空，不能报告就绪');
    state.docling = '2.138.0'; state.lock_sha256 = createHash('sha256').update(readFileSync(resolve(project, 'web/requirements-docling.lock'))).digest('hex');
    state.status = 'READY'; state.at = new Date().toISOString(); save(); console.log('PDF / DOCX / 扫描 PDF 本地验证通过；初始化就绪。');
  } catch (error) { state.status = 'FAILED'; save(); throw error; }
} else if (command === 'start') {
  mkdirSync(storage, { recursive: true });
  try { await owned(); throw Error('本工程已启动；请运行 npm run status'); } catch (error) { if (error.message.includes('已启动')) throw error; }
  const log = openSync(resolve(storage, 'server.log'), 'a', 0o600);
  const entry=process.env.LIGHTOG_START_ENTRY==='main-v1'?'scripts/start-product-main-v1.mjs':'web/start.mjs';
  const child = spawn(process.execPath, [entry, ...process.argv.slice(3)], { cwd: project, detached: true, stdio: ['ignore', log, log], env: { ...process.env, CQFORGE_STORAGE: storage, CQFORGE_PORT: String(port) } });
  closeSync(log); child.unref();
  // The child writes its own verified identity only after listening successfully.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await owned()).live.pid === child.pid) { ready = true; break; } } catch { /* Wait for this child's listening identity only. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  if (!ready) throw Error('后台启动未就绪；检查工作空间server.log或npm run status，不会结束端口占用者');
  console.log('CQForge后台已就绪，PID ' + child.pid + '，http://127.0.0.1:' + port);
} else if (command === 'status') {
  console.log(JSON.stringify((await owned()).live, null, 2));
} else if (command === 'stop') {
  const { saved, live } = await owned();
  if (live.active_task || live.active_evaluation || live.active_model_operation) throw Error('任务、评测或模型操作执行中；请先在工作台停止并等待当前调用结束');
  const response = await fetch('http://127.0.0.1:' + saved.port + '/api/shutdown', { method: 'POST', headers: { 'x-cqforge-control': saved.control }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('停止被拒绝；未发送 kill 信号'); console.log('已停止本工程服务。');
} else if (command === 'restore') {
  const source = resolve(process.argv[3] || ''), destination = resolve(process.argv[4] || '');
  if (!process.argv[3] || !process.argv[4] || existsSync(destination)) throw Error('需要备份目录与不存在的恢复目标目录；不会覆盖现有工作空间');
  if (!existsSync(resolve(source, 'cqforge.sqlite')) || !existsSync(resolve(source, 'attachments.json'))) throw Error('不是完整备份目录');
  const { createStore } = await import('./store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const original = new DatabaseSync(resolve(source, 'cqforge.sqlite'), { readOnly: true });
  try {
    if (original.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || original.prepare('PRAGMA foreign_key_check').all().length) throw Error('备份数据库完整性检查失败');
    const rows = original.prepare('SELECT * FROM artifacts ORDER BY path').all();
    if (JSON.stringify(rows) !== JSON.stringify(JSON.parse(readFileSync(resolve(source, 'attachments.json'))))) throw Error('备份附件清单与数据库不一致');
    for (const row of rows) if (createHash('sha256').update(readFileSync(resolve(source, row.path))).digest('hex') !== row.sha256) throw Error('备份附件不完整，禁止恢复');
  } finally { original.close(); }
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  const restored = createStore(destination);
  try {
    const errors = restored.verifyArtifacts();
    if (errors.length) throw Error('恢复附件哈希核对失败；目标保留供排查');
    for (const task of restored.listTasks()) for (const claim of task.result?.claims || []) {
      const doc = task.input.sources.find(s => s.id === claim.source_id);
      if (!doc || doc.content.slice(claim.start, claim.end) !== claim.quote) throw Error('恢复后的证据偏移不一致；目标保留供排查');
    }
    console.log(JSON.stringify({ restored: destination, tasks: restored.listTasks().length, artifacts: errors }));
  } finally { restored.close(); }
} else if (command === 'backup' || command === 'verify') {
  if (!existsSync(resolve(storage, 'cqforge.sqlite'))) throw Error('工作空间尚无 SQLite 数据库');
  const { createStore } = await import('./store.mjs'); const store = createStore(storage);
  try { console.log(JSON.stringify(command === 'backup' ? await store.makeBackup(resolve(process.argv[3] || (() => { throw Error('请提供新备份目录'); })())) : { errors: store.verifyArtifacts() }, null, 2)); }
  finally { store.close(); }
} else throw Error('未知命令');
