import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const project = fileURLToPath(new URL('../', import.meta.url));
export const parserPython = () => process.env.CQFORGE_DOCLING_PYTHON || resolve(project, '.venv-docling312', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor >= 22) || (major === 24 && minor >= 15);
}
export function cleanParserEnv() {
  return { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
    HF_HOME: resolve(project, '.ontoweave/docling-models'), HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_OFFLINE: '1', OMP_NUM_THREADS: '4' };
}
export function parserHealth({ base = project, python = parserPython(), checkPackage = true } = {}) {
  const file = resolve(base, '.ontoweave/setup-manifest.json');
  if (!existsSync(python)) return { status: 'MISSING_ENV', remedy: '安装 Python 3.12 后运行 npm run setup:parser' };
  if (!existsSync(file)) return { status: 'NOT_VERIFIED', remedy: '运行 npm run setup:parser；已有缓存将复用并校验' };
  try {
    const manifest = JSON.parse(readFileSync(file));
    if (manifest.status !== 'READY') return { status: manifest.status, remedy: '重新运行 npm run setup:parser（不会自动重传业务资料）' };
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw Error('EMPTY_MANIFEST');
    if (checkPackage) {
      const check = spawnSync(python, ['-c', 'import sys;from importlib.metadata import version;assert sys.version_info[:2]==(3,12);print(version("docling"))'], { encoding: 'utf8', env: cleanParserEnv(), timeout: 10000 });
      if (check.status !== 0 || check.stdout.trim() !== manifest.docling) return { status: 'BROKEN_ENV', remedy: '解析依赖版本变化或丢失；运行 npm run setup:parser' };
    }
    if (manifest.lock_sha256 && createHash('sha256').update(readFileSync(resolve(base, 'web/requirements-docling.lock'))).digest('hex') !== manifest.lock_sha256) return { status: 'DEPENDENCIES_CHANGED', remedy: '依赖锁已变化；运行 npm run setup:parser 重新验收' };
    for (const row of manifest.files) {
      const path = resolve(base, row.path), rel = relative(resolve(base, '.ontoweave'), path);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error('INVALID_MANIFEST');
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== row.sha256) return { status: 'CORRUPT_CACHE', file: row.path, remedy: '模型缓存损坏；运行 npm run setup:parser 修复并验证' };
    }
    return { status: 'READY', tested_at: manifest.at, docling: manifest.docling, files: manifest.files.length };
  } catch { return { status: 'INCOMPLETE_CACHE', remedy: '模型缺失或初始化中断；运行 npm run setup:parser' }; }
}
