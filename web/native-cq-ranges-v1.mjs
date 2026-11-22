/** Program-owned frozen unit ranges. Related material is not verified answer evidence. */
import {createHash} from 'node:crypto';
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
export const CQ_RANGE_CONTRACT='CQ_UNIT_RANGES_V1';
const sha=s=>createHash('sha256').update(s).digest('hex');
const distinct=rows=>[...new Map(rows.map(r=>[hash(r),r])).values()];
function range(chunk,units){return {contract:CQ_RANGE_CONTRACT,plan_ref:chunk.plan_ref,manifest_ref:chunk.manifest_ref,
 doc_ref:chunk.doc_ref,revision:chunk.revision,chunk_ref:chunk.chunk_ref,material_sha256:sha(chunk.contextualized_text),
 start:units[0].label,end:units.at(-1).label,unit_refs:units.map(u=>u.unit_ref),
 units_sha256:hash(units),selected_text_sha256:hash(units.map(u=>u.text)),context_sha256:hash(units.map(u=>u.context))};}
export function resolveCQUnitRanges(chunk,proposed){
 need(Array.isArray(chunk.units)&&chunk.units.length>0&&chunk.manifest_ref,'CQ_UNIT_MANIFEST_REQUIRED');
 const warnings=[],selected=new Set();let bad=false;
 if(!Array.isArray(proposed)||!proposed.length){warnings.push({code:'CQ_RANGE_MISSING_BLOCK_FALLBACK'});bad=true;}
 else for(const [index,r] of proposed.entries()){
  const start=chunk.units.findIndex(u=>u.label===r?.start),end=chunk.units.findIndex(u=>u.label===r?.end);
  if(!r||start<0||end<start||Object.keys(r).some(k=>!['start','end'].includes(k))){warnings.push({code:'CQ_RANGE_INVALID_BLOCK_FALLBACK',index});bad=true;continue;}
  for(let i=start;i<=end;i++)selected.add(i);
 }
 const ranges=[];let group=[];
 for(const i of [...selected].sort((a,b)=>a-b)){if(group.length&&i!==group.at(-1)+1){ranges.push(range(chunk,group.map(n=>chunk.units[n])));group=[];}group.push(i);}
 if(group.length)ranges.push(range(chunk,group.map(n=>chunk.units[n])));
 return {ranges,range_status:bad?(ranges.length?'PARTIAL_BLOCK_FALLBACK':'BLOCK_FALLBACK'):'UNIT_RANGES',
  fallback_ranges:bad?[range(chunk,chunk.units)]:[],range_warnings:warnings};
}
export function loadCQRangeMaterials({plan,item}){
 const chunks=plan.windows??plan.chunks,output=[];
 const ranges=distinct([...(item.ranges??[]),...(item.fallback_ranges??[])]);
 for(const r of ranges){
  const c=chunks.find(c=>c.chunk_ref===r.chunk_ref);
  need(c&&r.contract===CQ_RANGE_CONTRACT&&r.plan_ref===plan.plan_ref&&r.plan_ref===c.plan_ref&&r.doc_ref===c.doc_ref&&r.revision===c.revision&&r.manifest_ref===c.manifest_ref&&r.material_sha256===sha(c.contextualized_text),'CQ_RANGE_FROZEN_SOURCE_MISMATCH');
  const start=c.units.findIndex(u=>u.label===r.start),end=c.units.findIndex(u=>u.label===r.end),units=c.units.slice(start,end+1);
  need(start>=0&&end>=start&&hash(units.map(u=>u.unit_ref))===hash(r.unit_refs)&&hash(units)===r.units_sha256&&hash(units.map(u=>u.text))===r.selected_text_sha256&&hash(units.map(u=>u.context))===r.context_sha256&&units.every(u=>sha(u.text)===u.text_sha256),'CQ_RANGE_FROZEN_UNIT_MISMATCH');
  for(const u of units)output.push({doc_ref:c.doc_ref,revision:c.revision,chunk_ref:c.chunk_ref,unit_ref:u.unit_ref,label:u.label,text:u.text,context:u.context,source_items:clone(u.source_items),fragment:u.fragment});
 }
 const units=[...new Map(output.map(u=>[u.unit_ref,u])).values()];
 return {contract:CQ_RANGE_CONTRACT,range_status:item.range_status??'LEGACY_BLOCK_ONLY',units,text:units.map(u=>(u.context?'[CONTEXT]\n'+u.context+'\n':'')+'['+u.label+'] '+u.text).join('\n\n'),answer_coverage:'UNASSESSED'};
}
export function aggregateCQRangeItems(origins,plan=null){
 const consolidate=key=>{
  const rows=distinct(origins.flatMap(q=>q[key]??[]));if(!plan)return rows;
  const groups=new Map();for(const r of rows){const k=hash([r.plan_ref,r.manifest_ref,r.doc_ref,r.revision,r.chunk_ref]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  return [...groups.values()].flatMap(rs=>{
   const chunk=(plan.windows??plan.chunks).find(c=>c.chunk_ref===rs[0].chunk_ref);need(chunk,'CQ_RANGE_FROZEN_SOURCE_MISMATCH');
   // Authenticate before normalizing; never repair a stale or foreign range.
   loadCQRangeMaterials({plan,item:{ranges:rs}});
   return resolveCQUnitRanges(chunk,rs.map(r=>({start:r.start,end:r.end}))).ranges;
  });
 };
 return {ranges:consolidate('ranges'),fallback_ranges:consolidate('fallback_ranges'),
 range_warnings:origins.flatMap(q=>q.range_warnings??[]),range_status:origins.some(q=>q.range_status!=='UNIT_RANGES')?'BLOCK_FALLBACK_PRESENT':'UNIT_RANGES',
 local_questions:origins.flatMap(q=>q.local_questions??[{cq_ref:q.cq_ref,question:q.question,ranges:clone(q.ranges??[]),fallback_ranges:clone(q.fallback_ranges??[]),range_status:q.range_status}])};
}
export function canAggregateCQ(a,b){
 if(a.question.replace(/\s+/gu,' ').trim()!==b.question.replace(/\s+/gu,' ').trim())return false;
 const ar=a.ranges??[],br=b.ranges??[];
 // A fallback does not prove a shared knowledge target.
 if(a.range_status!=='UNIT_RANGES'||b.range_status!=='UNIT_RANGES')return a.cq_ref===b.cq_ref;
 return ar.some(x=>br.some(y=>x.doc_ref===y.doc_ref&&x.revision===y.revision&&(
  x.unit_refs.some(ref=>y.unit_refs.includes(ref))||x.selected_text_sha256===y.selected_text_sha256&&x.context_sha256===y.context_sha256)));
}
