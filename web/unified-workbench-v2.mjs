import { mountPgWorkspace } from './ontoweave-pg-workspace-v2.mjs';

const root = document.getElementById('app');

try {
  const response = await fetch('/api/bootstrap', {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw Error('无法读回工作台配置');
  const boot = await response.json();
  if (!boot?.ontoweave_pg) throw Error('当前服务未登记可用的 OntoWeave 工作台');
  mountPgWorkspace({ root, boot });
} catch {
  const section = document.createElement('section');
  section.className = 'boot';
  section.textContent = '暂时无法连接 OntoWeave 工作台。';
  root.replaceChildren(section);
}
