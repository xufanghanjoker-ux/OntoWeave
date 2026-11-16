/** Reusable retrieval hints and published-work receipts. Neither is a fact or an identity merge. */
import assert from 'node:assert/strict';
import{createHash}from'node:crypto';
import{extractionUnits,SOURCE_CONTEXT_VERSION}from'./source-context.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export const LEARNING_INDEX_VERSION='chunk_entity_retrieval_v1';
const normalize=s=>String(s).normalize('NFKC').toLowerCase();
function terms(text){const normalized=normalize(text),words=normalized.match(/[a-z][a-z0-9_-]{1,}/g)||[];for(const m of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)){const chars=[...m[0]];for(let i=0;i<chars.length-1;i++)words.push(chars[i]+chars[i+1]);}return words;}
const names=e=>[e.name,...e.name.split(/[（）()]/).map(x=>x.trim())].filter(n=>n.length>=2);
const recordId=(base,source)=>'index_'+hash([base,source.id,source.sha256,LEARNING_INDEX_VERSION,SOURCE_CONTEXT_VERSION]).slice(0,32);
function mentionRows(unit,entities=[]){
 const result=[],seen=new Set();const add=(mention,start,origin,entity_id=null)=>{const key=start+':'+mention.length+':'+(entity_id||'');if(seen.has(key))return;seen.add(key);result.push({mention,start:unit.start+start,end:unit.start+start+mention.length,origin,...(entity_id?{entity_id}:{})});};
 for(const e of entities)for(const label of names(e)){let from=0;while(from<unit.text.length){const at=unit.text.indexOf(label,from);if(at<0)break;add(label,at,'KNOWN_LABEL_RECALL_ONLY',e.id);from=at+label.length;}}
 // Cheap CQ-independent lexical/heading candidates; not complete NER and never facts.
 for(const m of unit.text.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}(?:\s+[A-Z][A-Za-z0-9_-]{2,}){0,2}\b|[“「]([^”」\n]{2,30})[”」]/g)){const word=m[1]||m[0],at=m.index+(m[1]?1:0);add(word,at,'LEXICAL_CANDIDATE');}
 return result;
}
export function createLearningIndex(store,baseId){
 assert(typeof baseId==='string'&&baseId,'索引必须按知识库隔离');
 function ensure(sources,entities=[]){
  const units=extractionUnits(sources),entityHash=hash(entities),rows=[];
  for(const source of sources){assert(source.sha256&&hashText(source.content)===source.sha256,'索引来源哈希不一致');const contextHash=hash(source.parsing?.blocks||[]),id=recordId(baseId,source),old=store.getRecord('learning_source_index',id),sourceUnits=units.filter(u=>u.source_id===source.id);
   let row=old;
   const valid=old?.id===id&&old.base_id===baseId&&old.source_id===source.id&&old.version===LEARNING_INDEX_VERSION&&old.source_sha256===source.sha256&&old.context_hash===contextHash&&old.digest===hash(old.units)&&old.units.length===sourceUnits.length&&old.units.every((u,i)=>u.id===sourceUnits[i].id&&u.start===sourceUnits[i].start&&u.end===sourceUnits[i].end&&Object.values(u.tf||{}).every(n=>Number.isFinite(n)&&n>0));
   if(!valid){row={id,base_id:baseId,source_id:source.id,source_sha256:source.sha256,context_hash:contextHash,version:LEARNING_INDEX_VERSION,units:sourceUnits.map(u=>{const tf=Object.create(null);for(const term of terms(u.text))tf[term]=(tf[term]||0)+1;const blocks=source.parsing?.blocks||[];const context=[...blocks.filter(b=>b.kind==='section_header'&&b.end<=u.start).slice(-2),...blocks.filter(b=>['table','section_header'].includes(b.kind)&&b.start<u.end&&b.end>u.start)].map(b=>({block_id:b.block_id,kind:b.kind,start:b.start,end:b.end}));return{id:u.id,start:u.start,end:u.end,context,tf,length:Object.values(tf).reduce((s,n)=>s+n,0),mentions:mentionRows(u,entities)};}),entity_hash:entityHash,status:'RETRIEVAL_HINTS_NOT_KNOWLEDGE',created_at:new Date().toISOString()};}
   else if(old.entity_hash!==entityHash){row=structuredClone(old);for(const u of row.units){const unit=sourceUnits.find(x=>x.id===u.id);u.mentions=[...u.mentions.filter(m=>m.origin!=='KNOWN_LABEL_RECALL_ONLY'),...mentionRows(unit,entities).filter(m=>m.origin==='KNOWN_LABEL_RECALL_ONLY')];}row.entity_hash=entityHash;}
   row.digest=hash(row.units);if(!valid||old.entity_hash!==entityHash)store.putRecord('learning_source_index',id,row);rows.push(row);
  }
  return{units,rows};
 }
 function enrich(sources,scopeRow,entities=[]){const{rows}=ensure(sources,entities);for(const row of rows){const unit=row.units.find(u=>u.id===scopeRow.unit_id);if(!unit)continue;const source=sources.find(s=>s.id===row.source_id);let changed=false;for(const m of [...(scopeRow.entity_mentions||[]),...(scopeRow.subjects||[])]){const mention=m.mention||m.name,start=m.mention_start??m.start,end=m.mention_end??(start+mention?.length);if(!Number.isInteger(start)||start<unit.start||end>unit.end||source.content.slice(start,end)!==mention)continue;if(!unit.mentions.some(x=>x.start===start&&x.end===end)){unit.mentions.push({mention,start,end,origin:'MODEL_SOURCE_MENTION_NOT_IDENTITY'});changed=true;}}if(changed){row.digest=hash(row.units);store.putRecord('learning_source_index',row.id,row);}}}
 function rank(sources,question,{entities=[],claims=[]}={}){
  const{units,rows}=ensure(sources,entities),metas=new Map(rows.flatMap(r=>r.units.map(u=>[u.id,u]))),queryTerms=[...new Set(terms(question))],df=new Map(queryTerms.map(t=>[t,[...metas.values()].filter(u=>Object.hasOwn(u.tf,t)&&u.tf[t]>0).length]));
  const direct=new Set(entities.filter(e=>names(e).some(n=>normalize(question).includes(normalize(n)))).map(e=>e.id));
  const neighbors=new Set(claims.filter(c=>direct.has(c.subject_id)||direct.has(c.value)).flatMap(c=>[c.subject_id,typeof c.value==='string'?c.value:null]).filter(id=>!direct.has(id)&&entities.some(e=>e.id===id)));
  return units.map(u=>{const m=metas.get(u.id),ids=new Set(m.mentions.map(x=>x.entity_id).filter(Boolean));let score=0;for(const term of queryTerms){const n=Object.hasOwn(m.tf,term)?m.tf[term]:0;if(n)score+=Math.log(1+(units.length+1)/(1+df.get(term)))*(n/(n+1.5));}const mentionMatches=[...new Set(m.mentions.filter(x=>x.mention.length>=2&&normalize(question).includes(normalize(x.mention))).map(x=>normalize(x.mention)))];const matched=[...direct].filter(id=>ids.has(id));score+=Math.min(4,mentionMatches.length)*1.5+matched.length*3+(direct.size>1&&matched.length===direct.size?8:0)+[...neighbors].filter(id=>ids.has(id)).length;return{...u,retrieval_score:score,entity_recall_ids:matched,mention_recall:mentionMatches.slice(0,12)};}).sort((a,b)=>b.retrieval_score-a.retrieval_score||a.source_id.localeCompare(b.source_id)||a.start-b.start);
 }
 function plan(sources,question,evidence,options={}){const ranked=rank(sources,question,options),required=ranked.filter(u=>evidence.some(e=>e.source_id===u.source_id&&e.start<u.end&&e.end>u.start));assert(required.length,'局部学习缺少准入证据窗口');const selected=new Map(required.map(u=>[u.id,u]));
  // Evidence windows are mandatory; remaining slots cover graph/entity retrieval and adjacent context.
  for(const u of ranked.filter(u=>u.retrieval_score>0)){if(selected.size>=Math.max(4,required.length))break;selected.set(u.id,u);}
  return{version:LEARNING_INDEX_VERSION,base_id:baseId,source_stamp:sources.map(s=>[s.id,s.sha256]),unit_ids:[...selected.keys()],evidence_unit_ids:required.map(u=>u.id),total_units:ranked.length,coverage:'LOCAL_RETRIEVAL_NOT_EXHAUSTIVE',ranking:ranked.slice(0,8).map(u=>({unit_id:u.id,score:u.retrieval_score,entity_ids:u.entity_recall_ids}))};
 }
 function expand(previous,sources,question,options={}){validateLearningPlan(previous,sources);const ranked=rank(sources,question,options),selected=new Set(previous.unit_ids);for(const unit of ranked){if(selected.size>=Math.min(ranked.length,previous.unit_ids.length+4))break;selected.add(unit.id);}return{...previous,unit_ids:[...selected],expansion_round:(previous.expansion_round||0)+1,coverage:selected.size===ranked.length?'ALL_WINDOWS_SELECTED_NOT_SEMANTIC_COMPLETENESS':'LOCAL_RETRIEVAL_NOT_EXHAUSTIVE'};}
 return{ensure,enrich,rank,plan,expand};
}
function hashText(text){return createHash('sha256').update(text).digest('hex');}

export function validateLearningPlan(plan,sources,evidence=[]){
 const units=extractionUnits(sources);assert(plan?.version===LEARNING_INDEX_VERSION&&JSON.stringify(plan.source_stamp)===JSON.stringify(sources.map(s=>[s.id,s.sha256])),'局部学习索引版本或来源已变化');
 assert(Array.isArray(plan.unit_ids)&&plan.unit_ids.length&&new Set(plan.unit_ids).size===plan.unit_ids.length&&plan.unit_ids.every(id=>units.some(u=>u.id===id)),'局部学习窗口无效');
 for(const e of evidence){const source=sources.find(s=>s.id===e.source_id);assert(source&&source.sha256===e.source_sha256&&source.content.slice(e.start,e.end)===e.quote,'局部学习准入证据已变化');assert(units.filter(u=>e.source_id===u.source_id&&e.start<u.end&&e.end>u.start).every(u=>plan.unit_ids.includes(u.id)),'局部学习不得遗漏准入证据窗口');}
 return units.filter(u=>plan.unit_ids.includes(u.id));
}

export function extractionDimension({schema,extractionSchema,cqs,definitions='',as_of=null,contract}){
 const plans=cqs.map(q=>schema.cq_plans.find(p=>p.cq_id===q.id)).filter(Boolean).map(({cq_id,reason,...p})=>p).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return hash({version:'extraction_dimension_v1',contract,definitions,as_of,entities:[...schema.entities].sort((a,b)=>a.id.localeCompare(b.id)),types:[...schema.entity_types].sort((a,b)=>a.id.localeCompare(b.id)),predicates:[...extractionSchema.predicates].sort((a,b)=>a.id.localeCompare(b.id)),plans});
}
export function createLearningLedger(store,baseId){
 const key=(dimension,unit)=>'work_'+hash([baseId,dimension,unit.id,unit.source_sha256,unit.layout_hash||null]).slice(0,32);
 return{
  lookup(dimension,unit,retained){const id=key(dimension,unit),row=store.getRecord('learning_processed_dimension',id);if(!row||row.id!==id||row.base_id!==baseId||row.dimension!==dimension||row.unit_id!==unit.id||row.source_sha256!==unit.source_sha256||row.status!=='PUBLISHED_CHECKED'||!Array.isArray(row.claims))return null;const {receipt_hash,...body}=row;if(receipt_hash!==hash(body))return null;const map=new Map(retained.map(c=>[c.id,c]));return row.claims.every(c=>map.has(c.id)&&hash(map.get(c.id))===c.hash)?row:null;},
  commit(job,{published=false}={}){const work=job.result?.incremental_work;if(!published||job.status!=='READY'||!work||job.result.gate?.action!=='ACCEPT_CANDIDATE')return;const units=extractionUnits(job.input.sources);for(const unitId of work.checked_unit_ids){const rawUnit=units.find(u=>u.id===unitId);if(!rawUnit)continue;const source=job.input.sources.find(s=>s.id===rawUnit.source_id),unit={...rawUnit,layout_hash:source.parsing?createHash('sha256').update(JSON.stringify(source.parsing.blocks||[])).digest('hex'):null};const claims=job.result.claims.filter(c=>work.predicate_ids.includes(c.predicate_id)&&c.source_id===unit.source_id&&c.start<unit.end&&c.end>unit.start);const id=key(work.dimension,unit);const receipt={id,base_id:baseId,dimension:work.dimension,unit_id:unit.id,source_id:unit.source_id,source_sha256:unit.source_sha256,status:'PUBLISHED_CHECKED',task_id:job.id,claims:claims.map(c=>({id:c.id,hash:hash(c)}))};store.putRecord('learning_processed_dimension',id,{...receipt,receipt_hash:hash(receipt)});}}
 };
}
