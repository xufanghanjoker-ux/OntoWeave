/** TEST ONLY: deterministic injectable product ports, no server/store/model. */
export function createMemoryMcpTestService({workspace_id='test-workspace',library_id='test-library',readOnly=false}={}){
  const binding=Object.freeze({workspace_id,library_id});
  const records=new Map(),calls=[];
  let sequence=0,revoked=false,instance='process-1';
  const reject=code=>{throw Object.assign(new Error('Synthetic rejected request'),{code,outcome:'REJECTED'});};
  const envelope=data=>({scope:{...binding},service_instance_ref:instance,data});
  const receipt=record=>({raw_saved:true,logical_ref:record.logical_ref,record_ref:record.record_ref,version:1,source_ingested_at:'2026-11-13T00:00:00.000Z',processing_state:'RECEIVED',publication_state:'UNPUBLISHED',replayed:false,record_publication:{capability:'RECORD_ONLY'},structured_knowledge:{published:false,readback_verified:false}});
  const log=(method,input,context,write=false)=>{
    calls.push({method,input:structuredClone(input),request_ref:context.request_ref,idempotency_key:context.idempotency_key});
    if(revoked)reject('CREDENTIAL_REVOKED');
    if(write&&readOnly)reject('FORBIDDEN');
    if(write&&(input.source?.kind!=='AGENT_REPORT'||!context.request_ref||!context.idempotency_key))reject('INVALID_ARGUMENTS');
  };
  const get=ref=>records.get(ref)||reject('NOT_FOUND');
  const save=(input,parent)=>{
    const n=++sequence;
    const row={record_ref:`test-record-${n}`,logical_ref:`test-logical-${n}`,text:input.text,source:structuredClone(input.source),valid_time:structuredClone(input.valid_time||{kind:'UNRESOLVED'}),...(parent?{supplements_record_ref:parent,relation_kind:'SUPPLEMENT',related_logical_refs:[get(parent).logical_ref]}:{})};
    records.set(row.record_ref,row);return envelope(receipt(row));
  };
  const service={
    binding,
    async search(input,context){log('search',input,context);return envelope({view:{knowledge_revision_ref:'knowledge-1',graph_revision_ref:'graph-1',source_index_revision:'source-index-1',knowledge_index_revision:'knowledge-index-1'},knowledge:Array.from({length:8},(_,i)=>({knowledge_ref:`k-${i}`,text:`Synthetic saved knowledge ${i}`,source:{kind:i?'AGENT_REPORT':'DOCUMENT'},evidence:Array.from({length:4},(_,j)=>({evidence_ref:`e-${i}-${j}`,source:{kind:i?'AGENT_REPORT':'DOCUMENT'},quote:'原'.repeat(500)}))})),gaps:['Synthetic ports do not run organization or publication.'],generated_answer:false});},
    async appendRecord(input,context){log('appendRecord',input,context,true);if(input.related_record_ref)get(input.related_record_ref);return save(input);},
    async addResult(input,context){log('addResult',input,context,true);get(input.record_ref);return save(input,input.record_ref);},
    async getRecord(input,context){log('getRecord',input,context);const record=get(input.record_ref);return envelope({record:structuredClone(record),supplements:[...records.values()].filter(row=>row.supplements_record_ref===record.record_ref).map(row=>structuredClone(row)),receipt:receipt(record)});},
    async getStatus(input,context){log('getStatus',input,context);return envelope(receipt(get(input.record_ref)));}
  };
  return {service,records,calls,revoke(){revoked=true;},setInstance(value){instance=value;}};
}
