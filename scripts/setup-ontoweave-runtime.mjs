#!/usr/bin/env node
/** Prepare and verify the local Codex protocol without starting a model session. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.ontoweave');
const expected = JSON.parse(readFileSync(join(root, 'contracts/workbench-runtime-v1/codex-protocol.json')));
const option = process.argv.find(value => value.startsWith('--codex='))?.slice(8);
const located = spawnSync('which', ['codex'], { encoding: 'utf8' });
const candidate = option ?? process.env.ONTOWEAVE_CODEX_EXECUTABLE ?? located.stdout?.trim();
if (!candidate) throw Error('Specify an installed native Codex executable with --codex=/path/to/codex.');
const executable = realpathSync(resolve(candidate));
accessSync(executable, constants.X_OK);
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
if (version.status !== 0) throw Error('Codex --version failed.');
const cliVersion = version.stdout.trim().replace(/^codex-cli\s+/, '');
if (cliVersion !== expected.cli_version) {
  throw Error(`Codex ${expected.cli_version} required. Found ${cliVersion}.`);
}

process.umask(0o077);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, 'runtime-preparation-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const schemaDir = join(scratch, 'schemas');
  const generated = spawnSync(executable, ['app-server', 'generate-json-schema', '--out', schemaDir],
    { encoding: 'utf8', timeout: 60000 });
  if (generated.status !== 0) throw Error('Codex protocol generation failed.');
  for (const [name, digest] of Object.entries(expected.schemas)) {
    if (sha256(readFileSync(join(schemaDir, name))) !== digest) {
      throw Error(`CODEX_PROTOCOL_SCHEMA_CHANGED: ${name}`);
    }
  }
  const lock = { ...expected, executable_sha256: sha256(readFileSync(executable)) };
  const lockBytes = JSON.stringify(lock, null, 2) + '\n';
  const lockSha = sha256(lockBytes);
  const lockFile = join(out, `runtime-lock-${lockSha}.json`);
  writeFileSync(join(scratch, 'runtime-lock.json'), lockBytes, { mode: 0o600 });
  renameSync(join(scratch, 'runtime-lock.json'), lockFile);
  writeFileSync(join(scratch, 'runtime.json'), JSON.stringify({
    executable, lock_file: lockFile, lock_sha256: lockSha,
  }, null, 2) + '\n', { mode: 0o600 });
  renameSync(join(scratch, 'runtime.json'), join(out, 'runtime.json'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('Local Codex runtime verified. Model requests sent: 0.');
