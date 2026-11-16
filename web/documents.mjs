import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { atomicFile } from './store.mjs';
import { cleanParserEnv, parserHealth } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const documentId = /^[a-f0-9-]{36}$/;
export function assembleDocument(raw, metadata) {
  if (!Array.isArray(raw.blocks) || !raw.blocks.length) throw Error('解析没有产生文本块');
  let content = ''; const blocks = [];
  for (const b of raw.blocks) {
    if (typeof b.text !== 'string' || !b.text.trim()) continue;
    if (content) content += '\n\n';
    const start = content.length; content += b.text;
    blocks.push({ block_id: b.block_id, kind: b.kind, start, end: content.length,
      provenance: b.provenance || [], text_origin: b.text_origin,...(b.table_geometry?{table_geometry:b.table_geometry}:{}) });
  }
  if (!content.trim()) throw Error('解析文字为空，请检查文档是否包含可识别文字');
  return { ...metadata, parser: raw.parser, parser_version: raw.parser_version, content,
    parsed_sha256: hash(content), blocks, warnings: raw.warnings || [], offset_unit: 'utf16_code_unit' };
}
export function createDocumentStore(storage, store = null) {
  mkdirSync(storage, { recursive: true }); let busy = false;
  function get(id) {
    if (!documentId.test(id)) throw Error('文档标识无效');
    const parsed = JSON.parse(readFileSync(resolve(storage, id, 'parsed.json'), 'utf8'));
    if (hash(parsed.content) !== parsed.parsed_sha256 || hash(readFileSync(resolve(storage, id, 'original' + parsed.extension))) !== parsed.original_sha256) throw Error('文档或解析结果哈希不一致，禁止沿用旧证据');
    return parsed;
  }
  async function parse(bytes, filename) {
    if (busy) throw Error('正在解析另一份文档，请稍后再试');
    const extension = extname(filename).toLowerCase();
    if (!['.pdf', '.docx', '.md'].includes(extension)) throw Error('Docling入口支持PDF、DOCX和UTF-8 Markdown；旧DOC请先另存DOCX');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('文件大小需要在1字节至20MB之间');
    if (extension === '.pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('文件不是PDF');
    if (extension === '.docx' && !bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw Error('文件不是DOCX容器');
    if (extension === '.md') {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw Error('Markdown文件需要使用UTF-8编码'); }
      if (text.includes('\0')) throw Error('Markdown文件不能包含二进制NUL字符');
    }
    const python = process.env.CQFORGE_DOCLING_PYTHON || resolve(root, '.venv-docling312', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!existsSync(python)) throw Error('未安装Docling环境，请按web/README.md安装');
    // Markdown uses Docling's local SimplePipeline, without PDF/OCR model artifacts.
    // Its installed backend is checked by the actual worker, not the PDF cache manifest.
    if (store && extension !== '.md' && parserHealth().status !== 'READY') throw Error('解析环境尚未验收或模型缓存不完整，请先运行 npm run setup；详情见 npm run doctor');
    busy = true;
    const id = randomUUID(), dir = resolve(storage, id); mkdirSync(dir);
    const original = resolve(dir, 'original' + extension), rawPath = resolve(dir, 'docling.json');
    atomicFile(original, bytes); store?.artifact(original);
    try {
      await new Promise((done, reject) => {
        const child = spawn(python, [resolve(root, 'web/docling_worker.py'), original, rawPath + '.tmp'], {
          env: cleanParserEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
        // Consume diagnostics without logging paths, document text or authentication material.
        let failure = 'PARSER_FAILED';
        child.stderr.on('data', bytes => { const match = bytes.toString().match(/"error_code":\s*"([A-Z_]+)"/); if (match) failure = match[1]; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('解析超过5分钟，已停止；原件保留，可稍后重试')); }, 300000);
        child.on('error', () => { clearTimeout(timer); reject(Error('无法启动Docling解析进程')); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? done() : reject(Error('Docling解析失败 [' + failure + ']：缺模型请运行 npm run setup；无文本请检查扫描件质量。原件已保留，未发送生成模型')); });
      });
      renameSync(rawPath + '.tmp', rawPath);
      const parsed = assembleDocument(JSON.parse(readFileSync(rawPath, 'utf8')), {
        document_id: id, title: basename(filename).slice(0, 180), extension,
        original_sha256: hash(bytes), original_bytes: bytes.length, created_at: new Date().toISOString() });
      atomicFile(resolve(dir, 'parsed.json'), JSON.stringify(parsed, null, 2));
      store?.artifact(rawPath); store?.artifact(resolve(dir, 'parsed.json'));
      return parsed;
    } finally { busy = false; }
  }
  return { parse, get, original(id) { const meta = get(id); return { meta, path: resolve(storage, id, 'original' + meta.extension) }; } };
}
