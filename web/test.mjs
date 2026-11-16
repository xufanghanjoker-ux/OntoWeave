/** Explicit file list: Windows shells need not expand wildcards. */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = ['web', 'experiments/local-loop', 'experiments/model-loop', 'experiments/value-bench']
  .flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.test.mjs')).map(name => resolve(dir, name)));
for (const args of [['--test', ...files], ['fixtures/tools/test-evaluator-gate.mjs']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
