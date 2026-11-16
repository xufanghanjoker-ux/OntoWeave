/** Lossless subdivision of a failed extraction window; never truncates source or candidate facts. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractionUnits} from './source-context.mjs';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const ADAPTIVE_PLAN_KEY='adaptive_extraction_plan_v1';
export function splitExtractionUnit(unit){
  if(unit.text.length<=800)return [];
  const maxChars=Math.max(400,Math.ceil(unit.text.length/2));
  const children=extractionUnits([{id:unit.source_id,title:unit.title,content:unit.text,sha256:unit.source_sha256}],{maxChars,overlap:Math.min(200,Math.floor(maxChars/4))});
  return children.map(c=>{const start=unit.start+c.start,end=unit.start+c.end;
    return {...c,start,end,root_unit_id:unit.root_unit_id||unit.id,parent_unit_id:unit.id,
      id:'unit_'+sha({source:unit.source_id,hash:unit.source_sha256,start,end,policy:'adaptive_extraction_v1'}).slice(0,24),policy:'adaptive_extraction_v1'};
  });
}
export const planDescriptors=units=>units.map(({id,source_id,source_sha256,start,end,root_unit_id,parent_unit_id,policy})=>({id,source_id,source_sha256,start,end,...(root_unit_id?{root_unit_id,parent_unit_id}:{}),policy}));
export function restoreExtractionPlan(descriptors,roots,sources){
  assert(Array.isArray(descriptors)&&descriptors.length&&descriptors.length<=10000,'抽取分块计划无效');
  const ids=new Set(),rootMap=new Map(roots.map(u=>[u.id,u])),sourceMap=new Map(sources.map(s=>[s.id,s]));
  const units=descriptors.map(d=>{
    const root=rootMap.get(d.root_unit_id||d.id),source=sourceMap.get(d.source_id);
    assert(root&&source&&root.source_id===d.source_id&&source.sha256===d.source_sha256&&!ids.has(d.id),'抽取分块身份无效');ids.add(d.id);
    assert(Number.isInteger(d.start)&&Number.isInteger(d.end)&&d.start>=root.start&&d.end<=root.end&&d.end>d.start,'抽取分块范围无效');
    return {...d,title:source.title,text:source.content.slice(d.start,d.end),offset_unit:'utf16_code_unit'};
  });
  for(const root of roots){
    const leaves=units.filter(u=>(u.root_unit_id||u.id)===root.id).sort((a,b)=>a.start-b.start);let cursor=root.start;
    for(const leaf of leaves){assert(leaf.start<=cursor,'抽取分块计划遗漏原文');cursor=Math.max(cursor,leaf.end);}
    assert(cursor===root.end,'抽取分块计划未覆盖完整原文');
  }
  return units;
}
