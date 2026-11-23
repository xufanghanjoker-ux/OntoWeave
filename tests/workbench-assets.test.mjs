import assert from 'node:assert/strict';
import test from 'node:test';
import {serveWorkbenchAsset, unifiedAssets} from '../web/workbench-assets.mjs';

function readAsset(path, assets) {
  const response = {
    writeHead(status, headers) { Object.assign(this, {status, headers}); },
    end(body) { this.body = body; },
  };
  assert.equal(serveWorkbenchAsset({method: 'GET'}, response, path, assets), true);
  assert.equal(response.status, 200);
  return response;
}

test('PG workbench entry, graph worker, and chat assets are all served', () => {
  const assets = unifiedAssets();
  const home = readAsset('/', assets);
  assert.match(home.body.toString(), /src="\/unified-workbench-v2\.mjs"/);
  for (const [, dependency] of home.body.toString().matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    assert.ok(readAsset(dependency, assets).body.length > 0, dependency);
  }
  for (const path of ['/assets/graph-view.mjs', '/assets/graph-fa2-worker-v1.mjs', '/lightog-chat-v1.css']) {
    assert.ok(readAsset(path, assets).body.length > 0, path);
  }
});

test('retired workbench endpoints and unlisted filesystem paths are excluded', () => {
  const assets = unifiedAssets();
  for (const path of ['/app.mjs', '/index.html', '/source-first', '/store.mjs', '/../package.json', '/%2e%2e/package.json']) {
    assert.equal(serveWorkbenchAsset({method: 'GET'}, {}, path, assets), false, path);
  }
});
