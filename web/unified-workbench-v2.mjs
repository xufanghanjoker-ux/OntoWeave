import { mountWorkbench } from './unified-workbench-controller-v2.mjs';

const root = document.getElementById('app');
const status = document.getElementById('toast');
let token;

async function api(path, data) {
  const write = data !== undefined;
  const headers = { Accept: 'application/json' };
  if (write && token) headers['X-CQForge-Token'] = token;
  const form = data instanceof FormData;
  if (write && !form) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers,
    body: write && !form ? JSON.stringify(data) : data,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Object.assign(new Error(result?.error?.message ?? '工作台暂时无法完成此操作。'), {
    code: result?.error?.code, status: response.status,
  });
  return result;
}

try {
  const boot = await api('/api/bootstrap');
  token = boot.token;
  if (!boot.ontoweave_pg && boot.source_first?.workspace_ui !== 'LIGHTOG_WORKSPACE_V1') {
    throw Error('当前服务未登记可用的 OntoWeave 工作台。');
  }
  await mountWorkbench({ root, boot, api, toast: text => { status.textContent = text; } });
} catch {
  const section = document.createElement('section');
  section.className = 'boot';
  section.textContent = '暂时无法连接 OntoWeave 工作台。';
  root.replaceChildren(section);
}
