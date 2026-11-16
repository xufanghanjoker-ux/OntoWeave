/** Display projection only. These nodes/edges never modify semantic claims or entity IDs. */
const palette=['#9ce7c8','#8acbb7','#b2d6c2','#9dbab0','#b7c9bb','#91c6bf'];
export const entityKey=id=>'entity:'+id;
export const claimKey=id=>'claim:'+id;
export function projectGraph(task,{statements=true,limit=1800}={}){
  const schema=task.result?.schema;if(!schema)throw Error('当前版本尚无本体数据');
  const claims=task.result.claims||[],entities=(schema.entities||[]).filter(e=>!e.structure_kind||claims.some(c=>c.subject_id===e.id)),byId=new Map(entities.map(e=>[e.id,e]));
  if(byId.size!==entities.length)throw Error('实体ID重复，不能安全绘图');
  const types=[...new Set(entities.map(e=>e.type))].sort(),predicates=new Map((schema.predicates||[]).map(p=>[p.id,p]));
  const nodes=entities.map((e,i)=>({id:entityKey(e.id),canonical_id:e.id,kind:'entity',label:e.name,
    type_label:schema.entity_types?.find(t=>t.id===e.type)?.label||e.type,structure_kind:e.structure_kind||null,participant_ids:e.participant_ids||[],color:palette[types.indexOf(e.type)%palette.length],degree:0,seed:i}));
  const n=new Map(nodes.map(node=>[node.id,node])),edges=[],ids=new Set();let omitted=0,invalid=0;
  for(const c of claims){
    if(ids.has(c.id))throw Error('声明ID重复，不能安全绑定证据');ids.add(c.id);
    const source=entityKey(c.subject_id),predicate=predicates.get(c.predicate_id);
    if(!n.has(source)||!predicate){invalid++;continue;}
    n.get(source).degree++;
    const planned=c.modality==='PLANNED',isEntity=predicate.value_type==='ENTITY',targetEntity=entityKey(c.value);
    if(isEntity){
      if(!byId.has(c.value)){invalid++;continue;}
      n.get(targetEntity).degree++;
      edges.push({id:'relation:'+c.id,source,target:targetEntity,claim_id:c.id,label:predicate.label,planned});
    }else if(statements){
      const id=claimKey(c.id),value=String(c.value??'');
      nodes.push({id,canonical_id:c.id,subject_id:c.subject_id,kind:'statement',label:value,
        predicate:predicate.label,planned,color:planned?'#c4a16e':'#738c80',degree:1,seed:nodes.length});
      edges.push({id:'statement:'+c.id,source,target:id,claim_id:c.id,label:predicate.label,planned});
    }else omitted++;
  }
  if(nodes.length>limit)throw Error(`当前投影有${nodes.length}个节点，超过本地画布上限${limit}；请缩小知识库范围，未静默截断。`);
  return {nodes,edges,entities:entities.length,claims:claims.length,omitted,invalid,version:task.id};
}
export function neighbors(data,id){const set=new Set([id]);for(const e of data.edges){if(e.source===id)set.add(e.target);if(e.target===id)set.add(e.source);}return set;}
