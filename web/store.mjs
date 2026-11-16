/** SQLite is authoritative; JSON is an interchange format, not a second database. */
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { answerPlan } from './engine.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const uuid = /^[a-f0-9-]{36}$/;
const encode = value => JSON.stringify(value);
export function atomicFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw Error('不可覆盖已存在的附件');
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function createStore(storage) {
  mkdirSync(storage, { recursive: true });
  const db = new DatabaseSync(resolve(storage, 'cqforge.sqlite'));
  chmodSync(resolve(storage, 'cqforge.sqlite'), 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if (db.prepare('PRAGMA user_version').get().user_version > 2) throw Error('数据库版本高于当前程序；请升级，不能降级写入');
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, status TEXT NOT NULL, parent_id TEXT, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id,kind,id));
    CREATE TABLE IF NOT EXISTS claims(task_id TEXT NOT NULL REFERENCES tasks(id), id TEXT NOT NULL, subject_id TEXT NOT NULL, predicate_id TEXT NOT NULL, value_json TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id,id));
    CREATE INDEX IF NOT EXISTS claim_lookup ON claims(task_id,predicate_id,subject_id,value_json);
    CREATE TABLE IF NOT EXISTS artifacts(path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workbench_records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
    PRAGMA user_version=2; COMMIT;`);
  let transactionDepth=0;
  const transaction = fn => {
    if(transactionDepth)return fn();
    db.exec('BEGIN IMMEDIATE');transactionDepth++;
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally{transactionDepth--;}
  };
  const getSetting = key => { const row = db.prepare('SELECT payload FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.payload) : null; };
  function setProfile(profile) {
    const safe = {};
    for (const key of ['baseUrl', 'model', 'maxTokens', 'allowInsecureHttp', 'thinkingMode']) if (profile[key] !== undefined) safe[key] = profile[key];
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('model', encode(safe));
  }
  function artifact(path) {
    const rel = relative(storage, resolve(path));
    if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error('附件路径超出工作空间');
    const bytes = readFileSync(path);
    const row = { path: rel, sha256: digest(bytes), bytes: bytes.length };
    const old = db.prepare('SELECT * FROM artifacts WHERE path=?').get(rel);
    if (old && (old.sha256 !== row.sha256 || old.bytes !== row.bytes)) throw Error('不可变附件哈希变化：' + rel);
    db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?)').run(rel, row.sha256, row.bytes);
    return row;
  }
  function saveTask(job, importedHash = null) {
    const purged=db.prepare("SELECT payload FROM workbench_records WHERE kind='library_lifecycle'").all().some(r=>{const l=JSON.parse(r.payload);return l.status==='PURGED'&&l.task_ids?.includes(job.id);});
    if(purged)throw Object.assign(Error('已删除知识库的任务不可重新写入'),{code:'LIBRARY_PURGED'});
    transaction(() => {
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,parent_id=excluded.parent_id,payload=excluded.payload')
        .run(job.id, job.status, job.revision?.parent_id || null, encode(job));
      db.prepare('DELETE FROM records WHERE task_id=?').run(job.id);
      db.prepare('DELETE FROM claims WHERE task_id=?').run(job.id);
      const record = db.prepare('INSERT INTO records VALUES(?,?,?,?)');
      const groups = { cq: job.input.cqs, source: job.input.sources, entity: job.result?.schema?.entities,
        predicate: job.result?.schema?.predicates, plan: job.result?.schema?.cq_plans,
        event: job.events, review: job.result?.gate?.issues };
      for (const [kind, values] of Object.entries(groups)) for (const [i, value] of (values || []).entries()) {
        record.run(job.id, kind, String(value.id || value.cq_id || i), encode(value));
      }
      for (const [i, claim] of (job.result?.claims || []).entries()) {
        db.prepare('INSERT INTO claims VALUES(?,?,?,?,?,?)').run(job.id, claim.id || String(i), claim.subject_id, claim.predicate_id, encode(claim.value), encode(claim));
        db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)').run(job.id, 'evidence', claim.evidence_id || claim.id || String(i), encode({ source_id: claim.source_id,
          start: claim.start, end: claim.end, quote: claim.quote, locations: claim.locations, document_id: claim.document_id, offset_unit: claim.offset_unit }));
      }
      if (importedHash) db.prepare('INSERT INTO imports VALUES(?,?)').run(job.id, importedHash);
    });
  }
  const getTask = id => { const row = db.prepare('SELECT payload FROM tasks WHERE id=?').get(id); return row && JSON.parse(row.payload); };
  const listTasks = () => db.prepare('SELECT payload FROM tasks ORDER BY id').all().map(row => JSON.parse(row.payload));
  function query(id, cqId) {
    const job = getTask(id); if (!job) throw Error('任务不存在');
    const plan = job.result?.schema?.cq_plans?.find(p => p.cq_id === cqId);
    return queryPlan(id, plan, job.input);
  }
  function queryPlan(id, plan, inputOverride) {
    const job = getTask(id); if (!job) throw Error('任务不存在');
    let claims = [];
    if (plan?.predicate_id) {
      const subjects = plan.template === 'COMPARE' ? plan.subject_ids : plan.subject_id ? [plan.subject_id] : [];
      const params = [id, plan.predicate_id];
      let sql = 'SELECT payload FROM claims WHERE task_id=? AND predicate_id=?';
      if (subjects.length) { sql += ' AND subject_id IN (' + subjects.map(() => '?').join(',') + ')'; params.push(...subjects); }
      if (plan.object_value !== null) { sql += ' AND value_json=?'; params.push(encode(plan.object_value)); }
      claims = db.prepare(sql + ' ORDER BY rowid').all(...params).map(row => JSON.parse(row.payload));
    }
    return { ...answerPlan({ ...(job.result || { status: job.status }), claims }, inputOverride || job.input, plan), backend: 'SQLITE', task_id: id, version: id };
  }
  function migrate() {
    const purgedIds=new Set(db.prepare("SELECT payload FROM workbench_records WHERE kind='library_lifecycle'").all().flatMap(r=>{const l=JSON.parse(r.payload);return l.status==='PURGED'?l.task_ids||[]:[];}));
    const files = readdirSync(storage).filter(id => !purgedIds.has(id) && uuid.test(id) && existsSync(resolve(storage, id, 'task.json')));
    const report = { at: new Date().toISOString(), imported: [], skipped: [], errors: [], backup: null };
    if (!files.length) return report;
    const pending = files.filter(id => !db.prepare('SELECT id FROM imports WHERE id=?').get(id));
    if (pending.length) {
      const dir = resolve(storage, 'legacy-backups', randomUUID()); mkdirSync(dir, { recursive: true });
      report.backup = relative(storage, dir);
      const manifest = [];
      function copyTree(from, to) {
        mkdirSync(to, { recursive: true });
        for (const item of readdirSync(from, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw Error('迁移不接受符号链接');
          const src = resolve(from, item.name), dst = resolve(to, item.name);
          if (item.isDirectory()) copyTree(src, dst);
          else { copyFileSync(src, dst); chmodSync(dst, 0o400); manifest.push({ path: relative(dir, dst), sha256: digest(readFileSync(src)) }); }
        }
      }
      for (const id of pending) copyTree(resolve(storage, id), resolve(dir, id));
      if (existsSync(resolve(storage, 'documents'))) copyTree(resolve(storage, 'documents'), resolve(dir, 'documents'));
      if (existsSync(resolve(storage, 'workspace.json'))) copyFileSync(resolve(storage, 'workspace.json'), resolve(dir, 'workspace.json'));
      atomicFile(resolve(dir, 'manifest.json'), encode(manifest)); chmodSync(resolve(dir, 'manifest.json'), 0o400);
    }
    // Preserve uploaded-but-unused documents and failed-upload originals in backups too.
    const docRoot = resolve(storage, 'documents');
    if (existsSync(docRoot)) for (const id of readdirSync(docRoot).filter(id => uuid.test(id))) {
      try {
        const dir = resolve(docRoot, id), parsedPath = resolve(dir, 'parsed.json');
        if (existsSync(parsedPath)) {
          const parsed = JSON.parse(readFileSync(parsedPath));
          if (!['.pdf', '.docx'].includes(parsed.extension) || digest(parsed.content) !== parsed.parsed_sha256
            || digest(readFileSync(resolve(dir, 'original' + parsed.extension))) !== parsed.original_sha256) throw Error('解析附件哈希不一致');
        }
        for (const name of ['original.pdf', 'original.docx', 'docling.json', 'parsed.json']) if (existsSync(resolve(dir, name))) artifact(resolve(dir, name));
      } catch (error) { report.errors.push({ id: 'document:' + id, error: error.message }); }
    }
    for (const id of files) {
      try {
        const bytes = readFileSync(resolve(storage, id, 'task.json')), hash = digest(bytes);
        const old = db.prepare('SELECT sha256 FROM imports WHERE id=?').get(id);
        if (old) { if (old.sha256 !== hash) throw Error('旧任务在迁移后被改写，未覆盖 SQLite'); report.skipped.push(id); continue; }
        if (getTask(id)) throw Error('任务ID已存在但未登记迁移，需人工核对');
        const job = JSON.parse(bytes);
        if (job.id !== id || !Array.isArray(job.input?.sources) || !Array.isArray(job.input?.cqs) || !job.status) throw Error('任务结构或ID无效');
        for (const source of job.input.sources) {
          if (source.sha256 && source.sha256 !== digest(source.content)) throw Error('来源哈希不一致');
          const doc = source.document_id || source.parsing?.document_id;
          if (doc) {
            if (!uuid.test(doc)) throw Error('文档ID无效');
            const parsedPath = resolve(storage, 'documents', doc, 'parsed.json');
            const parsed = JSON.parse(readFileSync(parsedPath));
            if (!['.pdf', '.docx'].includes(parsed.extension) || digest(parsed.content) !== parsed.parsed_sha256) throw Error('解析元数据不一致');
            const original = resolve(storage, 'documents', doc, 'original' + parsed.extension);
            if (digest(readFileSync(original)) !== parsed.original_sha256 || parsed.content !== source.content) throw Error('原文件或解析附件不一致');
            artifact(original); artifact(parsedPath); artifact(resolve(storage, 'documents', doc, 'docling.json'));
          }
        }
        for (const claim of job.result?.claims || []) {
          const source = job.input.sources.find(s => s.id === claim.source_id);
          if (!source || source.content.slice(claim.start, claim.end) !== claim.quote) throw Error('声明引文偏移无法回溯');
        }
        // Import marker and all task rows commit together; interruptions never produce a false success.
        for (const name of readdirSync(resolve(storage, id))) if (name !== 'task.json' && statSync(resolve(storage, id, name)).isFile()) artifact(resolve(storage, id, name));
        saveTask(job, hash);
        report.imported.push(id);
      } catch (error) { report.errors.push({ id, error: error.message }); }
    }
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('migration', encode(report));
    if (report.backup) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('last_migration_backup', encode(report));
    report.previous_backup = getSetting('last_migration_backup')?.backup || null;
    return report;
  }
  async function makeBackup(destination) {
    if (existsSync(destination)) throw Error('备份目标必须为新目录');
    mkdirSync(destination, { recursive: true });
    await backup(db, resolve(destination, 'cqforge.sqlite'));
    const snapshot = new DatabaseSync(resolve(destination, 'cqforge.sqlite'), { readOnly: true });
    const manifest = snapshot.prepare('SELECT * FROM artifacts ORDER BY path').all(); snapshot.close();
    for (const row of manifest) {
      const src = resolve(storage, row.path);
      if (digest(readFileSync(src)) !== row.sha256) throw Error('备份附件哈希不一致：' + row.path);
      const target = resolve(destination, row.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(src, target);
    }
    atomicFile(resolve(destination, 'attachments.json'), encode(manifest));
    return { database: 'cqforge.sqlite', artifacts: manifest.length };
  }
  function verifyArtifacts() {
    return db.prepare('SELECT * FROM artifacts').all().flatMap(row => {
      try { const bytes = readFileSync(resolve(storage, row.path));
        return bytes.length === row.bytes && digest(bytes) === row.sha256 ? [] : [{ path: row.path, error: 'HASH_MISMATCH' }];
      } catch { return [{ path: row.path, error: 'MISSING' }]; }
    });
  }
  const putRecord = (kind, id, value) => {
    db.prepare('INSERT INTO workbench_records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at')
      .run(kind, id, encode(value), new Date().toISOString()); return value;
  };
  const getRecord = (kind, id) => { const row = db.prepare('SELECT payload FROM workbench_records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.payload) : null; };
  const listRecords = kind => db.prepare('SELECT payload FROM workbench_records WHERE kind=? ORDER BY updated_at DESC,id').all(kind).map(row => JSON.parse(row.payload));
  function archiveRecord(kind, id, value) {
    const identity = digest(encode([kind, id]));
    const existing = getRecord('immutable_archive', identity);
    if (existing) {
      if (existing.content_sha256 !== digest(encode(value))) throw Error('已归档记录不能改写');
      return existing;
    }
    const path = resolve(storage, 'archives', randomUUID() + '.json');
    atomicFile(path, encode(value));
    const manifest = { ...artifact(path), content_sha256: digest(encode(value)) };
    putRecord('immutable_archive', identity, manifest); return manifest;
  }
  return { db, saveTask, getTask, listTasks, query, queryPlan, migrate, artifact, makeBackup, verifyArtifacts, getSetting, setProfile,
    putRecord, getRecord, listRecords, archiveRecord, transaction, close: () => db.close() };
}
