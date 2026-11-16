/** Browser-only derived display. Checksums bind data; they never grant authorization. */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const list=value=>Array.isArray(value)?value:[];
const clone=structuredClone;
const unique=values=>[...new Set(values)];
const normalize=value=>Array.isArray(value)?value.map(normalize):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
const canonical=value=>JSON.stringify(normalize(value));
const equal=(a,b)=>canonical(a)===canonical(b);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const ref=row=>row?.knowledge_ref??row?.record_ref??row?.fact_ref??row?.id;
const fail=(reason_code,path)=>{throw Object.assign(new Error(reason_code),{reason_code,path});};
const need=(value,code,path)=>{if(!value)fail(code,path);};
const distinct=values=>[...new Map(values.map(value=>[canonical(value),value])).values()];
const slotKey=(id,slot)=>canonical([id,slot]);
async function digest(value){
 need(globalThis.crypto?.subtle,'TEMPORAL_DISPLAY_CRYPTO_UNAVAILABLE','/temporal_projection');
 const bytes=new TextEncoder().encode(canonical(value)),hash=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function indexed(rows,path){
 need(Array.isArray(rows),'TEMPORAL_DISPLAY_RECORDS_INVALID',path);const result=new Map();
 for(const [index,row]of rows.entries()){
  const id=ref(row);need(object(row)&&text(id)&&!result.has(id),'TEMPORAL_DISPLAY_RECORD_ID_INVALID',path+'/'+index);result.set(id,row);
 }
 return result;
}
function generatedAttributes(attributes){
 if(Array.isArray(attributes))return attributes.flatMap((value,index)=>object(value)&&text(value.attribute??value.name)&&(Object.hasOwn(value,'value')||Object.hasOwn(value,'raw_value'))?[{index,name:value.name??value.attribute}]:[]);
 return object(attributes)?Object.entries(attributes).map(([key,value])=>({key,name:object(value)&&Object.hasOwn(value,'name')?value.name:key})):[];
}
function checkedSlot(source,slot){
 if(!object(slot))return null;
 if(slot.kind==='RECORD')return Object.keys(slot).length===1&&source.kind!=='ENTITY'?{slot:clone(slot),generated_name:null}:null;
 if(slot.kind!=='ENTITY_ATTRIBUTE'||source.kind!=='ENTITY'||!text(slot.key))return null;
 const attributes=source.attributes,generated=generatedAttributes(attributes);let found;
 if(slot.container==='MAP'&&Object.keys(slot).every(key=>['kind','container','key'].includes(key))&&object(attributes)&&Object.hasOwn(attributes,slot.key))found=generated.find(value=>value.key===slot.key);
 else if(slot.container==='LIST'&&Object.keys(slot).every(key=>['kind','container','index','key'].includes(key))&&Array.isArray(attributes)&&Number.isSafeInteger(slot.index)&&slot.index>=0)found=generated.find(value=>value.index===slot.index&&value.name===slot.key);
 return found&&text(found.name)&&generated.filter(value=>value.name===found.name).length===1?{slot:clone(slot),generated_name:found.name}:null;
}
function lineageCandidate(row,lineage,raw,sidecar){
 const fact=row.temporal_fact,id=ref(row),bad=reason_code=>({record_ref:id,fact_id:fact.fact_id,reason_code});
 if(!lineage||lineage.schema!=='TEMPORAL_KNOWLEDGE_LINEAGE_V1'||lineage.status!=='EXACT_PROGRAM_BINDING'||lineage.fact_id!==fact.fact_id||lineage.fact_version_id!==fact.fact_version_id)return {unresolved:bad('TEMPORAL_DISPLAY_LINEAGE_UNRESOLVED')};
 if(sidecar.selection?.policy!=='EXACT_CONFIRMED_REVISION_MEMBERSHIP'||sidecar.selection.confirmed!==true||sidecar.selection.is_current_library_revision!==true||lineage.adopted_in_bound_view!==true||lineage.display_relation!=='CURRENT_VERSION_OF_SOURCE_SLOT')return {unresolved:bad('TEMPORAL_DISPLAY_ADOPTION_UNCONFIRMED')};
 if(!equal(row.temporal_lineage,lineage))return {unresolved:bad('TEMPORAL_DISPLAY_ROW_LINEAGE_CHANGED')};
 const sources=lineage.source_knowledge_refs,slots=lineage.source_slots,bindings=lineage.bindings;
 if(!Array.isArray(sources)||sources.length!==1||!text(sources[0])||!Array.isArray(slots)||slots.length!==1||!Array.isArray(bindings)||!bindings.length)return {unresolved:bad('TEMPORAL_DISPLAY_LINEAGE_NOT_UNIQUE')};
 const declared=slots[0],source=raw.get(sources[0]);
 if(!source||source.temporal_fact||declared?.knowledge_ref!==sources[0])return {unresolved:bad('TEMPORAL_DISPLAY_SOURCE_UNAVAILABLE')};
 const slot=checkedSlot(source,declared.slot),key=slotKey(sources[0],declared.slot);
 if(!slot||declared.slot_ref!==undefined&&declared.slot_ref!==key)return {unresolved:bad('TEMPORAL_DISPLAY_SLOT_UNRESOLVED')};
 if(source.kind==='RULE'||row.kind==='RULE'||!['RELATION','ATTRIBUTE'].includes(row.kind))return {unresolved:bad('TEMPORAL_DISPLAY_INDEPENDENT_RECORD')};
 for(const binding of bindings){
  if(!object(binding)||binding.knowledge_ref!==sources[0]||!equal(binding.slot,declared.slot)||binding.source_slot_ref!==undefined&&binding.source_slot_ref!==key||binding.kernel_fact_version_id!==fact.fact_version_id||!['binding_sha256','interpretation_sha256','plan_sha256'].every(field=>sha(binding[field]))||!['source_run_id','source_snapshot_ref','incoming_ref','request_id'].every(field=>text(binding[field]))||!Number.isSafeInteger(binding.update_index)||binding.update_index<0||!['ADD_FACT','STATE_CHANGE','CORRECT','ADD_SUPPORT'].includes(binding.operation)||binding.original_attribute_slot!=null&&!equal(binding.original_attribute_slot,declared.slot))return {unresolved:bad('TEMPORAL_DISPLAY_KERNEL_BINDING_CHANGED')};
 }
 return {id,source_ref:sources[0],fact_id:fact.fact_id,fact_version_id:fact.fact_version_id,...slot,bindings:clone(bindings)};
}
const itemRefs=item=>unique([...list(item?.record_refs),...(text(item?.record_ref)?[item.record_ref]:[])]);
function clipped(item,removed){
 const before=itemRefs(item),after=before.filter(id=>!removed.has(id));
 if(before.length&&after.length===0)return null;
 const result=clone(item);
 if(before.length!==after.length){
  if(Array.isArray(item.record_refs))result.record_refs=after;
  if(text(item.record_ref)&&removed.has(item.record_ref))delete result.record_ref;
  result.display_lineage={...result.display_lineage,original_record_refs:before,replaced_record_refs:before.filter(id=>removed.has(id))};
 }
 return result;
}
function graphProjection(dto,sidecar,records,candidates,groups,warnings){
 const raw=dto.domain_graph,temporal=sidecar.temporal_graph;
 for(const [path,graph]of [['/domain_graph',raw],['/temporal_projection/temporal_graph',temporal]])need(object(graph)&&Array.isArray(graph.nodes)&&Array.isArray(graph.edges)&&Array.isArray(graph.knowledge),'TEMPORAL_DISPLAY_GRAPH_INVALID',path);
 const facts=new Set(records.filter(row=>row.temporal_fact).map(ref));
 const nodeMap=graph=>{const result=new Map();for(const node of graph.nodes){need(object(node)&&text(node.id)&&!result.has(node.id),'TEMPORAL_DISPLAY_NODE_ID_INVALID','/domain_graph/nodes');result.set(node.id,node);}return result;};
 const rawNodes=nodeMap(raw),newNodes=nodeMap(temporal),newEdges=new Map(),originalEdges=new Map();
 for(const edge of raw.edges){need(object(edge)&&text(edge.id)&&!originalEdges.has(edge.id),'TEMPORAL_DISPLAY_EDGE_INVALID','/domain_graph/edges');originalEdges.set(edge.id,edge);}
 const contributionRefs=new Set();
 function checkContribution(item,path){
  for(const id of itemRefs(item)){need(facts.has(id),'TEMPORAL_DISPLAY_GRAPH_FACT_UNKNOWN',path);contributionRefs.add(id);}
 }
 for(const [index,node]of temporal.nodes.entries()){
  checkContribution(node,'/temporal_projection/temporal_graph/nodes/'+index);
  for(const value of [...list(node.attributes),...list(node.rules)])checkContribution(value,'/temporal_projection/temporal_graph/nodes/'+index);
 }
 for(const [index,edge]of temporal.edges.entries()){
  need(object(edge)&&text(edge.id)&&!newEdges.has(edge.id)&&newNodes.has(edge.source)&&newNodes.has(edge.target),'TEMPORAL_DISPLAY_EDGE_INVALID','/temporal_projection/temporal_graph/edges/'+index);
  checkContribution(edge,'/temporal_projection/temporal_graph/edges/'+index);need(itemRefs(edge).length>0,'TEMPORAL_DISPLAY_GRAPH_FACT_UNKNOWN','/temporal_projection/temporal_graph/edges/'+index);newEdges.set(edge.id,edge);
 }
 for(const row of temporal.knowledge)need(facts.has(ref(row)),'TEMPORAL_DISPLAY_GRAPH_FACT_UNKNOWN','/temporal_projection/temporal_graph/knowledge');
 const recordReplacements=new Set(candidates.filter(value=>value.slot.kind==='RECORD'&&contributionRefs.has(value.id)).map(value=>value.source_ref));
 const slotReplacements=candidates.filter(value=>value.slot.kind==='ENTITY_ATTRIBUTE'&&contributionRefs.has(value.id));
 // Only explicit version contributions in the new graph can replace old version scaffolding.
 function details(values){return list(values).flatMap(item=>{
  const removed=new Set([...itemRefs(item).filter(id=>facts.has(id)&&contributionRefs.has(id)),...recordReplacements]);
  for(const candidate of slotReplacements)if(item.name===candidate.generated_name&&itemRefs(item).includes(candidate.source_ref))removed.add(candidate.source_ref);
  const result=clipped(item,removed);return result?[result]:[];
 });}
 const nodes=new Map();
 for(const [id,node]of rawNodes){
  const result=clone(node),before=itemRefs(node),after=unique(before.flatMap(value=>recordReplacements.has(value)?candidates.filter(candidate=>candidate.source_ref===value&&candidate.slot.kind==='RECORD').map(candidate=>candidate.id):[value]));
  if(Array.isArray(node.record_refs))result.record_refs=after;
  if(!equal(before,after))result.display_lineage={original_record_refs:before,replacement_record_refs:after};
  if(Array.isArray(node.attributes))result.attributes=details(node.attributes);
  if(Array.isArray(node.rules))result.rules=details(node.rules);
  nodes.set(id,result);
 }
 const compatible=(old,item,fields,path)=>{for(const field of fields)if(Object.hasOwn(old,field)&&Object.hasOwn(item,field)&&!equal(old[field],item[field]))fail('TEMPORAL_DISPLAY_GRAPH_ID_CONFLICT',path+'/'+field);};
 const mergeContributions=(old,item)=>({...old,record_refs:unique([...list(old.record_refs),...list(item.record_refs)]),source_refs:distinct([...list(old.source_refs),...list(item.source_refs)]),attributes:distinct([...list(old.attributes),...list(item.attributes)]),rules:distinct([...list(old.rules),...list(item.rules)])});
 for(const [id,node]of newNodes){
  const old=nodes.get(id);if(!old){nodes.set(id,clone(node));continue;}
  // The saved entity ID owns its label/type; a typed projection cannot silently rename it.
  for(const field of ['name','label','kind','entity_type','type'])if(Object.hasOwn(old,field)&&Object.hasOwn(node,field)&&!equal(old[field],node[field]))warnings.push({code:'TEMPORAL_DISPLAY_NODE_METADATA_PRESERVED',node_id:id,field});
  nodes.set(id,mergeContributions(old,clone(node)));
 }
 const edges=new Map();
 for(const [index,edge]of raw.edges.entries()){
  need(object(edge)&&text(edge.id)&&!edges.has(edge.id),'TEMPORAL_DISPLAY_EDGE_INVALID','/domain_graph/edges/'+index);
  const removed=new Set([...recordReplacements,...itemRefs(edge).filter(id=>facts.has(id)&&contributionRefs.has(id))]);
  const value=clipped(edge,removed);if(value){if(Array.isArray(value.attributes))value.attributes=details(value.attributes);edges.set(value.id,value);}
 }
 for(const [id,edge]of newEdges){
  const original=originalEdges.get(id);
  if(original)compatible(original,edge,['source','target','predicate','label','direction','kind','conditions','negation','modality','unit','exceptions','comparison','valid_time'],'/temporal_projection/temporal_graph/edges/'+id);
  const old=edges.get(id);
  if(old){compatible(old,edge,['source','target','predicate','label','direction','kind','conditions','negation','modality','unit','exceptions','comparison','valid_time'],'/temporal_projection/temporal_graph/edges/'+id);edges.set(id,mergeContributions(old,clone(edge)));}
  else edges.set(id,clone(edge));
 }
 for(const edge of edges.values())need(nodes.has(edge.source)&&nodes.has(edge.target),'TEMPORAL_DISPLAY_EDGE_ENDPOINT_UNAVAILABLE','/domain_graph/edges/'+edge.id);
 const definitions=new Map();
 for(const item of [...list(raw.definitions),...list(temporal.definitions)]){
  const id=item?.definition_ref??item?.id??item?.key;need(text(id),'TEMPORAL_DISPLAY_DEFINITION_ID_INVALID','/domain_graph/definitions');
  const old=definitions.get(id);if(old){compatible(old,item,['kind','name','description','status'],'/domain_graph/definitions/'+id);definitions.set(id,mergeContributions(old,clone(item)));}else definitions.set(id,clone(item));
 }
 const revision='lightog-temporal-display:'+sidecar.projection_sha256,domain={...clone(raw),nodes:[...nodes.values()],edges:[...edges.values()],definitions:[...definitions.values()],knowledge:clone(records),revision_ref:revision};
 for(const field of ['record_sha256','graph_sha256','signature','signature_sha256','projection_sha256'])delete domain[field];
 return {library_id:dto.library_id,source_snapshot_ref:dto.binding.source_snapshot_ref,library_revision_ref:dto.binding.library_revision_ref,index_scope_run_id:dto.binding.index_scope_run_id,index_revision:revision,domain_graph:domain,knowledge:clone(records),lightog_display:{policy:'TEMPORAL_LINEAGE_DISPLAY_V1',knowledge_count:groups.length,raw_record_count:records.length,projection_sha256:sidecar.projection_sha256}};
}

/** A missing sidecar preserves the legacy UI. Invalid data never produces a fallback display graph. */
export async function createTemporalDisplay(dto){
 if(dto?.temporal_projection===undefined||dto?.temporal_projection===null)return null;
 try{
  // Awaited WebCrypto must not mix a later caller mutation into the checked snapshot.
  dto=clone(dto);
  const sidecar=clone(dto.temporal_projection),binding=dto.binding,basis=sidecar.basis;
  need(sidecar.schema==='TEMPORAL_KNOWLEDGE_READ_PROJECTION_V1','TEMPORAL_DISPLAY_SCHEMA_INVALID','/temporal_projection/schema');
  need(object(binding)&&['index_scope_run_id','source_snapshot_ref','library_revision_ref','record_sha256','graph_revision_ref','source_index_revision','knowledge_index_revision','commit_ref','confirmation_ref'].every(key=>text(binding[key]))&&object(basis)&&['library_id','run_id','revision_ref'].every(key=>text(basis[key]))&&text(dto.library_id)&&basis.library_id===dto.library_id&&basis.run_id===binding.index_scope_run_id&&basis.revision_ref===binding.library_revision_ref&&basis.record_sha256===binding.record_sha256&&sha(basis.record_sha256),'TEMPORAL_DISPLAY_BASIS_MISMATCH','/temporal_projection/basis');
  need(equal(sidecar.current_view_binding,binding),'TEMPORAL_DISPLAY_CURRENT_BINDING_MISMATCH','/temporal_projection/current_view_binding');
  const {projection_sha256,...body}=sidecar;need(sha(projection_sha256)&&await digest(body)===projection_sha256,'TEMPORAL_DISPLAY_PROJECTION_HASH_CHANGED','/temporal_projection/projection_sha256');
  const {current_view_binding,read_projection_sha256,...readBody}=body;need(sha(read_projection_sha256)&&await digest(readBody)===read_projection_sha256,'TEMPORAL_DISPLAY_READ_HASH_CHANGED','/temporal_projection/read_projection_sha256');
  need(sidecar.historical_artifacts_modified===false,'TEMPORAL_DISPLAY_HISTORY_MUTATION','/temporal_projection/historical_artifacts_modified');
  const raw=indexed(dto.knowledge,'/knowledge'),projected=indexed(sidecar.knowledge,'/temporal_projection/knowledge');
  need(raw.size===projected.size&&[...raw.keys()].every(id=>projected.has(id)),'TEMPORAL_DISPLAY_RECORD_MEMBERSHIP_CHANGED','/temporal_projection/knowledge');
  for(const [id,row]of projected){
   const original=raw.get(id);
   need(!row.library_id||row.library_id===dto.library_id,'TEMPORAL_DISPLAY_RECORD_LIBRARY_MISMATCH','/temporal_projection/knowledge/'+id);
   if(original.temporal_fact)need(equal(original.temporal_fact,row.temporal_fact)&&text(row.temporal_fact.fact_id)&&row.temporal_fact.fact_version_id===id,'TEMPORAL_DISPLAY_FACT_VERSION_CHANGED','/temporal_projection/knowledge/'+id+'/temporal_fact');
   else need(!row.temporal_fact&&equal(row,original),'TEMPORAL_DISPLAY_SOURCE_RECORD_CHANGED','/temporal_projection/knowledge/'+id);
  }
  need(Array.isArray(sidecar.lineage),'TEMPORAL_DISPLAY_LINEAGE_INVALID','/temporal_projection/lineage');
  const unresolved=[],warnings=clone(list(sidecar.warnings)),lineages=new Map(),facts=new Map();
  for(const [index,row]of sidecar.lineage.entries()){
   const id=row?.fact_version_id;need(object(row)&&text(id)&&projected.get(id)?.temporal_fact,'TEMPORAL_DISPLAY_LINEAGE_RECORD_UNKNOWN','/temporal_projection/lineage/'+index);lineages.set(id,[...list(lineages.get(id)),row]);
  }
  for(const row of projected.values())if(row.temporal_fact){const id=row.temporal_fact.fact_id;facts.set(id,[...list(facts.get(id)),ref(row)]);}
  const candidates=[];
  for(const row of projected.values())if(row.temporal_fact){
   const id=ref(row),entries=lineages.get(id);
   if(entries?.length!==1||facts.get(row.temporal_fact.fact_id).length!==1){unresolved.push({record_ref:id,fact_id:row.temporal_fact.fact_id,reason_code:'TEMPORAL_DISPLAY_MULTIPLE_VISIBLE_VERSIONS'});continue;}
   const candidate=lineageCandidate(row,entries[0],raw,sidecar);if(candidate.unresolved)unresolved.push(candidate.unresolved);else candidates.push(candidate);
  }
  const occupants=new Map();for(const candidate of candidates){const key=slotKey(candidate.source_ref,candidate.slot);occupants.set(key,[...list(occupants.get(key)),candidate]);}
  const accepted=candidates.filter(candidate=>{if(occupants.get(slotKey(candidate.source_ref,candidate.slot)).length===1)return true;unresolved.push({record_ref:candidate.id,reason_code:'TEMPORAL_DISPLAY_SLOT_VERSION_CONFLICT'});return false;});
  const groupsById=new Map([...projected.keys()].map(id=>[id,{id,member_refs:[id],preferred_ref:id}])),slots=[];
  for(const candidate of accepted){
   const group=groupsById.get(candidate.source_ref);group.member_refs.push(candidate.id);
   if(candidate.slot.kind==='RECORD')group.preferred_ref=candidate.id;
   const slot={knowledge_ref:candidate.source_ref,slot:clone(candidate.slot),generated_name:candidate.generated_name,fact_refs:[candidate.id],fact_version_ids:[candidate.fact_version_id],preferred_ref:candidate.id,bindings:clone(candidate.bindings)};
   slots.push(slot);group.slots=[...list(group.slots),slot];groupsById.delete(candidate.id);
  }
  const groups=[...groupsById.values()],member_to_group=new Map(groups.flatMap(group=>group.member_refs.map(id=>[id,group.id]))),records=clone(sidecar.knowledge);
  const graph=graphProjection(dto,sidecar,records,accepted,groups,warnings);
  return {status:'READY',graph,projected_records:records,groups,member_to_group,slots,unresolved,warnings,basis:clone(basis),current_view_binding:clone(binding),projection_sha256:sidecar.projection_sha256,read_projection_sha256:sidecar.read_projection_sha256,source_originals:new Map([...raw].filter(([,row])=>!row.temporal_fact).map(([id,row])=>[id,clone(row)]))};
 }catch(error){return {status:'UNAVAILABLE',reason_code:error?.reason_code??'TEMPORAL_DISPLAY_INVALID',path:error?.path??'/temporal_projection'};}
}
