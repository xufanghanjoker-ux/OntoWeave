import {build} from 'esbuild';
import {readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licenseName = 'CHAT_MARKDOWN_THIRD_PARTY_LICENSES.txt';
const result = await build({absWorkingDir: root, entryPoints: ['web/lightog-chat-markdown-v1.mjs'],
  outdir: 'web/assets', outExtension: {'.js': '.mjs'}, bundle: true, format: 'esm',
  platform: 'browser', target: ['es2022'], minify: true, legalComments: 'linked',
  metafile: true, write: false,
  banner: {js: `/*! CQForge chat Markdown. Third-party license texts: ./${licenseName} */`}});

const packages = new Set();
for (const path of Object.keys(result.metafile.inputs)) {
  const part = path.split('node_modules/')[1];
  if (part) packages.add(part.startsWith('@') ? part.split('/').slice(0, 2).join('/') : part.split('/')[0]);
}
let notices = 'CQForge chat Markdown bundle — third-party licenses. Generated from installed locked dependencies.\n';
for (const name of [...packages].sort()) {
  const folder = resolve(root, 'node_modules', name), pkg = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
  if (!['MIT', 'ISC', 'Apache-2.0'].includes(pkg.license)) throw Error('Unreviewed chat Markdown dependency license: ' + name + ' ' + pkg.license);
  let license;
  for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'License', 'LICENSE.MIT']) {
    try { license = readFileSync(resolve(folder, file), 'utf8'); break; } catch {}
  }
  if (!license) throw Error('Missing complete third-party license: ' + name);
  notices += '\n\n=== ' + name + ' ' + pkg.version + ' (' + pkg.license + ') ===\n' + license;
}
// Validate licenses before replacing any served artifact. Never fetch at runtime.
mkdirSync(resolve(root, 'web/assets'), {recursive: true});
const files = [{path: resolve(root, 'web/assets', licenseName), contents: notices}, ...result.outputFiles];
const staged = files.map(file => {
  const temporary = file.path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, file.contents);
  return {temporary, path: file.path};
});
for (const file of staged) renameSync(file.temporary, file.path);
console.log('Chat Markdown bundle built locally; ' + packages.size + ' dependency licenses retained.');
