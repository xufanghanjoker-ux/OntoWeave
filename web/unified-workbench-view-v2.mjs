export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const control=(text,action,attrs='',cls='')=>`<button type="button" class="lw-button ${cls}" data-lw-action="${action}" ${attrs}>${esc(text)}</button>`;

export function lightogHeader(s, { library, actions, navPages = {} } = {}){
 const nav=[['graph','图谱','◈'],['ontology','本体','◇'],['sources','资料','▤'],['pending','待处理','◌'],['query','问答','⌕']];
 const page=s.route.page;
 const title=library??`<button class="lw-library-title" data-lw-action="page" data-page="libraries">${esc(s.view?.library?.name??'我的知识空间')} <span>⌄</span></button>`;
 const controls=actions??control('＋ 添加资料','page','data-page="upload"','primary')+control('设置','page','data-page="settings"');
 return `<header class="lw-header"><button class="lw-brand" data-lw-action="page" data-page="libraries"><span>✳</span>OntoWeave</button><span class="lw-divider">/</span>${title}<div class="lw-header-actions">${controls}</div></header><nav class="lw-nav" aria-label="知识库工作区">${nav.map(([id,text,icon])=>{
  const target=navPages[id]??id;
  return `<button data-lw-action="page" data-page="${esc(target)}" ${page===target||id==='sources'&&page==='reader'?'aria-current="page"':''}><span aria-hidden="true" data-nav-icon="${icon}"></span>${text}</button>`;
 }).join('')}<span class="lw-nav-caption">基于资料的知识空间</span></nav>`;
}

export function lightogWorkspaceShell(s, { body, shellClass = '', mainClass = '', header, banner = '' }){
 return `<div class="lw-app ${esc(shellClass)}">${lightogHeader(s,header)}${banner}<main class="lw-main ${esc(mainClass)}">${body}</main></div>`;
}
