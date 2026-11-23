import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw Error('不可覆盖已存在的附件');
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
