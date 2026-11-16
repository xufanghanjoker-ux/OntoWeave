/** Pure compatibility projection. No I/O, entity matching, date arithmetic or record suppression. */
const list=value=>Array.isArray(value)?value:[];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const directions=new Set(['SUBJECT_TO_OBJECT','OBJECT_TO_SUBJECT','UNDIRECTED','NONE']);
export const TEMPORAL_KNOWLEDGE_PROJECTION='TEMPORAL_KNOWLEDGE_PROJECTION_V1';

export function projectTemporalKnowledgeRecord(record,{lineage=null,entities=[]}={}) {
  const row=structuredClone(record),fact=row.temporal_fact;
  if(!fact)return row;
  const content=fact.content??{},context=object(content.conditions)?content.conditions:{},warnings=[];
  const recordType=typeof context.record_type==='string'?context.record_type.toUpperCase():null;
  let kind=recordType==='ATTRIBUTE'?'ATTRIBUTE':recordType==='RELATION'?'RELATION':'TEXT',direction=null;
  if(!['ATTRIBUTE','RELATION'].includes(recordType))warnings.push('TEMPORAL_RECORD_TYPE_UNRESOLVED');
  if(!text(content.subject_ref)||!text(content.predicate)||!Object.hasOwn(content,'value')){
    kind='TEXT';warnings.push('TEMPORAL_RECORD_STRUCTURE_UNRESOLVED');
  }
  if(kind==='RELATION'){
    const a=content.value?.direction,b=context.direction;
    direction=a??b??null;
    if(!object(content.value)||!text(content.value.object_ref)||!directions.has(direction)
      ||a!=null&&b!=null&&a!==b){kind='TEXT';warnings.push('TEMPORAL_RELATION_ENDPOINT_OR_DIRECTION_UNRESOLVED');}
  }
  // A derived row must never carry a signature that purports to sign its changed shape.
  if(Object.hasOwn(row,'record_sha256')){row.projection_basis_record_sha256=row.record_sha256;delete row.record_sha256;}
  delete row.attribute;delete row.object_ref;delete row.direction;
  row.kind=kind;row.subject_ref=content.subject_ref;row.predicate=content.predicate;row.raw_value=structuredClone(content.value);
  if(kind==='ATTRIBUTE')row.attribute=content.predicate;
  if(kind==='RELATION'){row.object_ref=content.value.object_ref;row.direction=direction;const annotations=context.relation_annotations;if(annotations?.policy==='EXPLICIT_RELATION_METADATA_V1'){if(annotations.attributes!==null&&annotations.attributes!==undefined)row.attributes=structuredClone(annotations.attributes);if(annotations.companion_value)row.relation_value=structuredClone(annotations.companion_value);}}
  row.conditions=structuredClone(content.conditions??null);row.negation=content.negated??null;row.modality=content.modality;
  if(typeof content.negated!=='boolean')warnings.push('TEMPORAL_NEGATION_UNKNOWN');
  row.valid_time=structuredClone(fact.valid_time);row.asserted_valid_time=structuredClone(fact.asserted_valid_time);
  for(const key of ['unit','exceptions','comparison'])if(Object.hasOwn(context,key))row[key]=structuredClone(context[key]);
  const refs=[content.subject_ref,...(kind==='RELATION'?[row.object_ref]:[])].filter(text);
  const existing=[...list(row.domain?.entities),...list(entities)],byRef=new Map(existing.map(e=>[e.id,e]));
  row.domain={...(row.domain??{}),entities:refs.map(id=>structuredClone(byRef.get(id)??{id,name:id,label:id,kind:'ENTITY',
    identity_policy:'EXACT_SOURCE_LOCAL_REF_ONLY_NO_CANONICAL_MERGE',source_refs:row.source_refs??[]}))};
  delete row.domain.relation;
  row.temporal_projection={schema:TEMPORAL_KNOWLEDGE_PROJECTION,record_type:recordType,status:kind==='TEXT'?'UNRESOLVED':'STRUCTURED',warnings};
  const selected=lineage??row.temporal_lineage;
  row.temporal_lineage=selected?.fact_id===fact.fact_id&&selected?.fact_version_id===fact.fact_version_id
    ?structuredClone(selected):{schema:'TEMPORAL_KNOWLEDGE_LINEAGE_V1',fact_id:fact.fact_id,fact_version_id:fact.fact_version_id,
      status:'UNRESOLVED',source_knowledge_refs:[],source_slots:[],bindings:[]};
  return row;
}
