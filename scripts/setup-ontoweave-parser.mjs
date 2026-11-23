/** Set up the isolated document parser and verify its local model cache. */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { project, supportedNode, parserPython, parserHealth, cleanParserEnv } from '../web/runtime.mjs';

if (!supportedNode()) throw Error('需要 Node 22.22+ 或 24.15+（只支持这两条偶数版本线）：https://nodejs.org/en/download');
const run = (binary, args, env = process.env) => new Promise((done, reject) => {
  const child = spawn(binary, args, { cwd: project, env, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(Error('步骤失败（退出码 ' + code + '）；未报告初始化成功，请修复后重试')));
});

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
const prior = parserHealth();
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
