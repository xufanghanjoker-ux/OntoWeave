/** Pure current-view selection. The caller supplies a single kernel-selected view;
 * this module never chooses dates, rewrites history, or compares business triples. */
import {canonical,clone} from './cq-discovery-store-v2.mjs';
import {readDomainAttributes} from './native-domain-knowledge-v1.mjs';
const list=value=>Array.isArray(value)?value:[];
const ref=row=>row.knowledge_ref??row.record_ref;
const unique=rows=>[...new Map(rows.map(row=>[canonical(row),row])).values()];
export const CURRENT_LINEAGE_PROJECTION='CURRENT_ORIGIN_SLOT_FACT_VERSION_V1';
const unsigned=row=>{if(Object.hasOwn(row,'record_sha256')){row.projection_basis_record_sha256=row.record_sha256;delete row.record_sha256;}return row;};
function slotExists(row,slot){
 if(slot?.kind==='RECORD')return ['ATTRIBUTE','RELATION'].includes(row.kind);
 if(slot?.kind!=='ENTITY_ATTRIBUTE'||row.kind!=='ENTITY')return false;
 if(slot.container==='LIST')return Number.isSafeInteger(slot.index)&&slot.index>=0&&Array.isArray(row.attributes)
  &&readDomainAttributes([row.attributes[slot.index]]).length===1&&readDomainAttributes([row.attributes[slot.index]])[0].name===slot.key;
 return slot.container==='MAP'&&row.attributes&&!Array.isArray(row.attributes)&&Object.hasOwn(row.attributes,slot.key)
  &&readDomainAttributes({[slot.key]:row.attributes[slot.key]}).length===1;
}
export function projectCurrentKnowledgeLineage(rows){
 const knowledge=clone(rows),warnings=[],byRef=new Map(),byFact=new Map(),claims=new Map();
 for(const row of knowledge){const key=ref(row);byRef.set(key,[...(byRef.get(key)??[]),row]);
  if(row.temporal_fact){const id=row.temporal_fact.fact_id;byFact.set(id,[...(byFact.get(id)??[]),row]);}}
 for(const row of knowledge.filter(row=>row.temporal_fact)){
  const fact=row.temporal_fact,lineage=row.temporal_lineage;
  if(!['ATTRIBUTE','RELATION'].includes(row.kind)||lineage?.status!=='EXACT_PROGRAM_BINDING'
   ||lineage.fact_id!==fact.fact_id||lineage.fact_version_id!==fact.fact_version_id){warnings.push({code:'CURRENT_LINEAGE_UNRESOLVED',record_ref:ref(row)});continue;}
  if(byFact.get(fact.fact_id).length!==1){warnings.push({code:'CURRENT_LINEAGE_MULTIPLE_FACT_VERSIONS',fact_id:fact.fact_id});continue;}
  for(const source of list(lineage.source_slots)){
   const key=canonical([source.knowledge_ref,source.slot]),originals=byRef.get(source.knowledge_ref)??[],bindings=list(lineage.bindings).filter(b=>b.knowledge_ref===source.knowledge_ref&&canonical(b.slot)===canonical(source.slot));
   if(source.slot_ref!=null&&source.slot_ref!==key||originals.length!==1||originals[0].temporal_fact||!slotExists(originals[0],source.slot)
    ||!bindings.length||!bindings.every(b=>b.source_slot_ref===key&&b.binding_sha256&&b.plan_sha256&&b.kernel_fact_version_id)){
    warnings.push({code:'CURRENT_LINEAGE_SLOT_UNVERIFIED',record_ref:ref(row),source_knowledge_ref:source.knowledge_ref,slot:clone(source.slot)});continue;}
   claims.set(key,[...(claims.get(key)??[]),{row,original:originals[0],slot:source.slot,bindings}]);
  }
 }
 const replacements=[],suppressed=new Set(),slotsByRef=new Map(),originsByVersion=new Map();
 for(const [slotRef,raw]of claims){
  const owners=unique(raw.map(c=>({fact_id:c.row.temporal_fact.fact_id,fact_version_id:c.row.temporal_fact.fact_version_id})));
  if(owners.length!==1){warnings.push({code:'CURRENT_LINEAGE_SLOT_MULTIPLE_FACTS',source_slot_ref:slotRef,owners});continue;}
  const c=raw[0],sourceRef=ref(c.original),versionRef=ref(c.row),origin={knowledge_ref:sourceRef,slot:clone(c.slot),source_slot_ref:slotRef,
   fact_id:c.row.temporal_fact.fact_id,fact_version_id:c.row.temporal_fact.fact_version_id,bindings:unique(raw.flatMap(x=>x.bindings)),original_record:clone(c.original)};
  originsByVersion.set(versionRef,[...(originsByVersion.get(versionRef)??[]),origin]);
  if(c.slot.kind==='RECORD')suppressed.add(sourceRef);else slotsByRef.set(sourceRef,[...(slotsByRef.get(sourceRef)??[]),c.slot]);
  replacements.push({source_knowledge_ref:sourceRef,source_slot_ref:slotRef,slot:clone(c.slot),current_record_ref:versionRef,...owners[0]});
 }
 const selected=knowledge.filter(row=>!suppressed.has(ref(row))).map(row=>{
  const slots=slotsByRef.get(ref(row)),origins=originsByVersion.get(ref(row));
  if(slots){unsigned(row);if(Array.isArray(row.attributes)){const omitted=new Set(slots.map(s=>s.index));row.attributes=row.attributes.filter((_,i)=>!omitted.has(i));}
   else for(const slot of slots)delete row.attributes[slot.key];
   row.current_lineage_projection={policy:CURRENT_LINEAGE_PROJECTION,role:'SOURCE_WITH_PROJECTED_ATTRIBUTE_SLOTS',projected_slots:clone(slots)};}
  if(origins){unsigned(row);for(const key of ['source_refs','source_record_refs','evidence','evidence_refs','record_source_evidence'])
    row[key]=unique([...list(row[key]),...origins.flatMap(o=>list(o.original_record[key]))]);
   row.current_lineage_projection={policy:CURRENT_LINEAGE_PROJECTION,role:'CURRENT_FACT_VERSION',origins};}
  return row;
 });
 return {policy:CURRENT_LINEAGE_PROJECTION,knowledge:selected,replacements,warnings,historical_artifacts_modified:false};
}
