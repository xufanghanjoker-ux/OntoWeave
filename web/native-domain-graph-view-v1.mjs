/** Read-only domain workspace. Provider content is escaped; source text stays selectable. */
import {readNativeDomainGraph,listNativeDomainEntities,listNativeDomainKnowledge,inspectNativeDomainGraph,nativeDomainKnowledgeKind} from './native-domain-graph-data-v1.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const array=value=>Array.isArray(value)?value:[];
const label=value=>typeof value==='string'?value:value?.label??value?.name??value?.message??value?.code??JSON.stringify(value);
const literalShape=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['value','raw_value','unit','datatype','type'].includes(k))&&(Object.hasOwn(value,'value')||Object.hasOwn(value,'raw_value'));
const summaryShape=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&(typeof value.summary==='string'||typeof value.text==='string');
const valueText=value=>{
 if(value===null)return '未注明';
 if(literalShape(value)){const content=valueText(Object.hasOwn(value,'value')?value.value:value.raw_value),unit=typeof value.unit==='string'?value.unit.trim():'';return content+(unit&&!content.endsWith(' '+unit)?' '+unit:'');}
 if(summaryShape(value))return value.summary??value.text;
 if(Array.isArray(value)&&value.every(v=>v===null||typeof v!=='object'))return value.map(valueText).join('、');
 return typeof value==='object'?JSON.stringify(value):String(value??'');
};
const details=(title,body,open=false)=>body?`<details class="native-domain-details"${open?' open':''}><summary>${escape(title)}</summary><div class="native-domain-detail-body">${body}</div></details>`:'';
const line=(name,value)=>{
 if(value===undefined||value===null||value==='')return '';
 const complex=typeof value==='object'&&!literalShape(value)&&!summaryShape(value)&&!(Array.isArray(value)&&value.every(v=>v===null||typeof v!=='object'));
 return complex?details(name+'：查看结构化内容',`<pre>${escape(JSON.stringify(value,null,2))}</pre>`):`<div class="native-domain-field"><span>${escape(name)}</span><div>${escape(valueText(value))}</div></div>`;
};
const cut=(text,max)=>[...String(text)].slice(0,max).join('')+([...String(text)].length>max?'…':'');
const selectedAttr=(selected,id,kind)=>selected?.id===id&&(selected.kind===kind||(kind==='relation'&&selected.kind==='statement'))?' aria-current="true"':'';

export function nativeDomainEntityList(payload,query='',{selected=null}={}){
 const data=readNativeDomainGraph(payload),{items,total}=listNativeDomainEntities(payload,query),types=[...new Set([...(data?.nodes.values()??[])].map(n=>n.type_label||'未分类'))].sort();
 return `<div class="native-domain-list-count">${query?'匹配':'全部'} ${total} 个对象${total>items.length?` · 显示前 ${items.length} 个`:''}</div>`+items.map(n=>`<button type="button" data-action="native-domain-node" data-id="${escape(n.id)}"${selectedAttr(selected,n.id,'entity')}><span class="graph-list-dot native-domain-color-${types.indexOf(n.type_label||'未分类')%6}"></span><span class="native-domain-object-name">${escape(n.name)}<small>${escape(n.type_label||'未分类')}</small></span><span class="native-domain-degree" title="相邻对象数">${data.adjacency.get(n.id).size}</span></button>`).join('')+
  (total>items.length?'<p class="help">继续输入可缩小范围。</p>':total?'':'<p class="help">没有匹配的对象。</p>');
}

export function nativeDomainKnowledgeList(payload,query='',{selected=null}={}){
 const {items,total}=listNativeDomainKnowledge(payload,query);
 return `<div class="native-domain-list-count">${query?'匹配':'全部'} ${total} 条知识${total>items.length?` · 显示前 ${items.length} 条`:''}</div>`+items.map(({id,record,text})=>`<button type="button" class="claim-button native-domain-record" data-action="native-domain-knowledge" data-id="${escape(id)}"${selectedAttr(selected,id,'knowledge')}><span class="native-domain-kind">${escape(nativeDomainKnowledgeKind(record.kind))}</span><span>${escape(cut(text||'查看已保存的结构化内容',160))}</span><small>${array(record.source_refs).length} 个来源${array(record.warnings).length||array(record.gaps).length?' · 有处理提示':''}</small></button>`).join('')+
  (total>items.length?'<p class="help">输入内容可继续查找。</p>':total?'':'<p class="help">暂无匹配知识。</p>');
}

export function nativeDomainGraphMarkup(payload,{selected=null,title='领域关系图',sources=[]}={}){
 const data=readNativeDomainGraph(payload);if(!data)return '';
 const count=listNativeDomainKnowledge(payload).total,knowledge=`<details class="native-domain-all-knowledge" open><summary>已保存知识 · ${count}</summary><div class="native-domain-knowledge-toolbar"><p class="help">查看关系、属性、规则及独立陈述，点击可在详情和主图中定位。</p><input data-native-knowledge-search aria-label="搜索已保存知识" placeholder="搜索知识、属性或规则…"></div><div data-native-domain-knowledge>${nativeDomainKnowledgeList(payload,'',{selected})}</div></details>`;
 if(!data.nodes.size)return `<section class="native-domain-section"><header class="native-domain-heading"><div><h2>领域关系图</h2><p class="help">本轮尚未形成可画出的领域对象；已保存的知识可从下方列表查看。</p></div></header><div data-native-domain-inspector>${nativeDomainInspector(payload,selected,{sources})}</div>${knowledge}</section>`;
 const types=[...new Set([...data.nodes.values()].map(n=>n.type_label||'未分类'))].sort();
 const command=(text,value)=>`<button type="button" class="graph-tool" data-graph-command="${value}">${text}</button>`;
 return `<section class="native-domain-section"><header class="native-domain-heading"><div><h2>领域关系图</h2><p class="help">查看对象、关系与来源；图中只呈现已保存的关联。</p></div><span class="native-domain-library-name">${escape(title)}</span></header>
 <div class="graph-workbench native-domain-workbench" data-native-domain-graph-workbench>
  <details class="graph-browser native-domain-browser" open><summary class="graph-browser-title">对象 <span>${data.nodes.size}</span></summary><div class="graph-browser-content"><input data-native-domain-search aria-label="搜索领域对象" placeholder="搜索对象或类型…"><nav data-native-domain-entities aria-label="领域对象列表">${nativeDomainEntityList(payload,'',{selected})}</nav></div></details>
  <div class="graph-stage"><div class="native-domain-canvas-toolbar"><span class="native-domain-canvas-label">关系视图</span><div class="graph-tools" aria-label="领域图操作">${command('＋','in')}${command('−','out')}${command('适应视图','fit')}<details class="graph-tool-menu"><summary class="graph-tool">更多</summary><div>${command('重新布局','layout')}${command('环形布局','circle')}${command('仅看邻域','focus')}${command('返回全图','unfocus')}${command('开启动效','motion')}</div></details></div></div>
   <div class="native-domain-type-legend" aria-label="按对象类型筛选">${types.map((type,index)=>`<button type="button" data-graph-command="type" data-type="${escape(type)}" aria-pressed="true"><i class="native-domain-color-${index%6}"></i>${escape(type)}<small>${[...data.nodes.values()].filter(n=>(n.type_label||'未分类')===type).length}</small></button>`).join('')}<button type="button" data-graph-command="reset-types" class="native-domain-reset">重置筛选</button></div>
   <div class="graph-surface" data-graph-surface role="img" aria-label="可缩放拖拽的领域关系图；可通过左侧对象列表和下方知识列表选择" tabindex="0"></div>
   <div class="graph-caption"><span data-graph-status role="status">正在加载领域关系图…</span><span class="native-domain-canvas-hint">点击选择 · 双击查看邻域 · 拖动平移，滚轮缩放</span></div>
  </div>
  <aside class="graph-evidence native-domain-inspector" data-native-domain-inspector aria-label="领域知识详情">${nativeDomainInspector(payload,selected,{sources})}</aside>
 </div>${knowledge}</section>`;
}

function sourceMarkup(record,sources){
 const refs=array(record.source_refs),evidence=array(record.evidence),quotes=[];
 const quote=(value,located=false)=>{if(typeof value==='string'&&value.trim()&&!quotes.some(q=>q.text===value))quotes.push({text:value,located});};
 evidence.forEach(e=>{quote(e.quote??e.span?.quote,true);array(e.spans).forEach(s=>quote(s.quote,true));});
 quote(record.model_quote??record.quote,false);
 const names=refs.map(ref=>{
  // Missing identity must not match an unset alias on the first library source.
  const docRef=typeof ref?.doc_ref==='string'&&ref.doc_ref.trim()?ref.doc_ref:null;
  const source=docRef?sources.find(s=>s&&[s.key,s.id,s.source_id,s.source_ref,s.document_id,s.doc_id].includes(docRef)):null;
  const filename=typeof ref?.filename==='string'&&ref.filename.trim()?ref.filename:null;
  const title=source?.title??source?.name??source?.filename??filename??docRef??'来源未标明';
  return `<div class="native-domain-source"><strong>${escape(title)}</strong>${!docRef?'<small>缺少文档引用</small>':''}${ref?.revision?`<small title="${escape(ref.revision)}">版本 ${escape(cut(ref.revision,12))}</small>`:''}${ref?.unit_ref?details('来源定位信息',line('分块',ref.unit_ref)):''}</div>`;
 }).join('');
 return `<div class="native-domain-sources">${quotes.map(q=>`<div class="native-domain-evidence"><header><small>${q.located?'已保存的原文片段':'抽取时保留的引句'}</small><button type="button" class="native-domain-copy" data-graph-command="copy-source">复制原文</button></header><blockquote data-source-quote>${escape(q.text)}</blockquote></div>`).join('')}${names}${!quotes.length?`<p class="help">${refs.length?'保留了资料上下文，本条暂无可展示的精确引句。':'当前记录暂无可展示的来源片段。'}</p>`:''}</div>`;
}
function attributesMarkup(value){
 if(Array.isArray(value))return value.map(a=>{if(!a||typeof a!=='object')return line('属性',a);const raw=Object.hasOwn(a,'value')?a.value:Object.hasOwn(a,'raw_value')?a.raw_value:a.text??a.description;return line(a.name??a.label??a.attribute??a.predicate??a.role??'属性',a.unit?{value:raw,unit:a.unit}:raw);}).join('');
 if(value&&typeof value==='object')return Object.entries(value).map(([key,v])=>line(key,v)).join('');
 return value?`<p>${escape(valueText(value))}</p>`:'';
}
function knowledgeMarkup(record,sources,objectNames={}){
 const text=record.statement??record.text??record.rule_text??'',condition=array(record.conditions).map(label).join('；');
 const participants=array(record.participants).map(p=>`${p.role??'参与对象'}：${p.name??p.label??p.subject_name??objectNames[p.subject_ref??p.entity_ref]??p.subject_ref??p.entity_ref??''}`).join('；');
 const warnings=[...array(record.warnings),...array(record.gaps)].map(w=>`<p class="help">${escape(label(w))}</p>`).join('');
 return `<article class="native-domain-knowledge"><header><span class="native-domain-kind">${escape(nativeDomainKnowledgeKind(record.kind))}</span>${warnings?'<span class="native-domain-warning">有处理提示</span>':''}</header>${text?`<p class="native-domain-statement">${escape(text)}</p>`:''}${line('属性',record.attribute)}${Object.hasOwn(record,'raw_value')?line('值',record.unit?{value:record.raw_value,unit:record.unit}:record.raw_value):line('单位',record.unit)}${record.rule_text&&record.rule_text!==text?line('规则',record.rule_text):''}${line('适用条件',condition)}${line('参与对象',participants)}${record.negation===true?line('表述','原文表达否定。'):''}${line('语气',record.modality)}${line('时间',record.time_text)}${line('版本',record.version_text)}${attributesMarkup(record.qualifiers)}${details('来源与原文 · '+array(record.source_refs).length,sourceMarkup(record,sources),true)}${details('处理提示',warnings)}</article>`;
}
const relationRows=(relations,selected)=>relations.map(e=>`<button type="button" class="claim-button native-domain-relation" data-action="native-domain-relation" data-id="${escape(e.id)}"${selectedAttr(selected,e.id,'relation')}><span>${escape(e.source_name)} <span class="native-domain-arrow">${['UNDIRECTED','NONE'].includes(e.direction)?'—':'→'}</span> ${escape(e.target_name)}</span><strong>${escape(e.label)}</strong></button>`).join('');
export function nativeDomainInspector(payload,selected,{sources=[]}={}){
 if(!selected?.id)return '<div class="inspector native-domain-empty-inspector"><span class="native-domain-eyebrow">知识详情</span><h2>选择一个对象或关系</h2><p>从主图或对象列表开始，查看关系方向、属性值、适用条件和原文来源。</p><div class="native-domain-empty-steps"><span>01 对象与类型</span><span>02 关系、属性与规则</span><span>03 来源与原文</span></div><p class="help">独立陈述和未入图的知识也可从下方列表查看。</p></div>';
 const detail=inspectNativeDomainGraph(payload,selected.id,selected.kind);if(!detail)return '<div class="inspector"><p class="help">当前图中没有这个对象或关系，请重新选择。</p></div>';
 const item=detail.item,isRelation=detail.kind==='relation',isKnowledge=detail.kind==='knowledge';
 const title=isRelation?item.label:isKnowledge?nativeDomainKnowledgeKind(item.kind):item.name,aliases=array(item.aliases).map(label).join('、'),description=item.description??item.definition;
 const definitions=detail.definitions.map(d=>`<p><strong>${escape(d.label??d.name??d.key??'定义')}</strong></p>${line('含义',d.description??d.definition)}${line('类型',d.datatype??d.value_type)}${line('单位',d.unit)}`).join('');
 const attributes=attributesMarkup(item.attributes)+attributesMarkup(item.qualifiers)+attributesMarkup(item.statement_qualifiers);
 const samePair=detail.parallel_relations??[],relations=isRelation&&samePair.length>1?samePair:!isRelation?detail.relations:[];
 return `<div class="inspector"><header class="native-domain-inspector-heading"><div><span class="native-domain-eyebrow">${isRelation?'关系详情':isKnowledge?'已保存知识':'对象详情'}</span><h2>${escape(title)}</h2></div><button type="button" class="btn tiny" data-action="native-domain-clear" aria-label="关闭知识详情">关闭</button></header>${isRelation?`<div class="native-domain-endpoints"><button type="button" data-action="native-domain-node" data-id="${escape(item.source)}">${escape(detail.source?.name??'')}</button><span>${['UNDIRECTED','NONE'].includes(item.direction)?'—':'→'}</span><button type="button" data-action="native-domain-node" data-id="${escape(item.target)}">${escape(detail.target?.name??'')}</button></div>`:isKnowledge?'':line('类型',item.type_label||'未分类')}${line('其他名称',aliases)}${line('含义',description)}${attributes?details('属性与限定条件',attributes,true):''}${details('类型与关系定义',definitions)}
 ${relations.length?details(isRelation?'同一对对象的关系 · '+relations.length:'相关关系 · '+relations.length,relationRows(relations,selected),true):''}
 ${isKnowledge&&!relations.length&&!detail.entity_ids?.length?'<p class="help native-domain-unmapped">这条知识未关联到可画出的对象，可继续检查正文与来源。</p>':''}
 <section class="native-domain-records"><h3>知识与原文 · ${detail.records.length}</h3>${detail.records.map((r,index)=>detail.records.length>1?`<details class="native-domain-record-fold"${index===0?' open':''}><summary><span class="native-domain-kind">${escape(nativeDomainKnowledgeKind(r.kind))}</span><span>${escape(cut(r.statement??r.text??r.rule_text??r.attribute??'查看知识正文',70))}</span></summary>${knowledgeMarkup(r,sources,detail.object_names)}</details>`:knowledgeMarkup(r,sources,detail.object_names)).join('')||'<p class="help">暂无可关联的知识正文。</p>'}</section>${detail.unresolved_record_refs.length?'<p class="help">部分关联记录尚未包含在当前图读回结果中。</p>':''}</div>`;
}
