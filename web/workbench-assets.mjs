import {readFileSync, realpathSync} from 'node:fs';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const webRoot = fileURLToPath(new URL('./', import.meta.url));

export function serveWorkbenchAsset(req, res, pathname, assets) {
  if (req.method !== 'GET' || !Object.hasOwn(assets, pathname)) return false;
  const [name, mime] = assets[pathname];
  const bytes = readFileSync(resolve(webRoot, name));
  res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
  return true;
}

const media = {
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};

export function unifiedAssets() {
  const assets = { '/': ['unified-workbench-v2.html', 'text/html'] };
  const approved = JSON.parse(readFileSync(resolve(webRoot, 'unified-workbench-v2.assets.json'), 'utf8'));
  if (!Array.isArray(approved)) throw Error('UNIFIED_WORKBENCH_ASSET_MANIFEST_INVALID');
  const root = realpathSync(webRoot) + sep;
  for (const filename of approved) {
    if (typeof filename !== 'string' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(filename) ||
        !Object.hasOwn(media, extname(filename)) || Object.hasOwn(assets, '/' + filename) ||
        !realpathSync(resolve(webRoot, filename)).startsWith(root)) {
      throw Error('UNIFIED_WORKBENCH_ASSET_MANIFEST_INVALID');
    }
    assets['/' + filename] = [filename, media[extname(filename)]];
  }
  return assets;
}
