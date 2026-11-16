/** Confirmed memory current view only. No run APIs, invented fingerprints, or client publication hashes. */
import {lightogMemoryCurrentBinding,projectLightogReading,attachLightogTemporalDisplay} from './lightog-reading-data-v1.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const rows=input=>Array.isArray(input)?input.flatMap(row=>Array.isArray(row?.items)?row.items:[row]):Array.isArray(input?.items)?input.items:[];
const docKey=row=>JSON.stringify([row?.doc_ref??row?.doc_id??row?.source_ref,row?.revision??row?.source_revision]);
const body=row=>row?.text??row?.content??row?.parsing?.content;
const invalid=(message,diagnostic=null)=>Object.assign(new Error(message),{code:'MEMORY_CURRENT_VIEW_INVALID',...(diagnostic?{reason_code:diagnostic.code,path:diagnostic.path,diagnostic}:{})});

/** Synchronous pure projection. An invalid envelope throws, never returns a fake empty view. */
export function projectLightogMemoryCurrentView(dto,{libraryId,documents=null,blocks=null,sources=[]}={}){
  const checked=lightogMemoryCurrentBinding(dto,libraryId??null);
  if(checked.status!=='READY')throw invalid(checked.reason,checked.diagnostic);
  const currentView=structuredClone(dto),b=currentView.binding;
  const extras=[...rows(documents),...rows(sources)];
  const retained=currentView.source_snapshot.documents.map((original,index)=>{
    if(!object(original)||!text(original.doc_ref??original.doc_id)||!text(original.revision)||typeof body(original)!=='string'||original.library_id&&original.library_id!==currentView.library_id||original.source_snapshot_ref&&original.source_snapshot_ref!==b.source_snapshot_ref)throw invalid('当前资料版本未完整绑定，未替换为其他原文。',{code:'MEMORY_CURRENT_VIEW_SOURCE_DOCUMENT_INVALID',path:'/source_snapshot/documents/'+index});
    const matching=extras.filter(row=>docKey(row)===docKey(original));
    for(const row of matching)if(row.source_snapshot_ref&&row.source_snapshot_ref!==b.source_snapshot_ref||typeof body(row)==='string'&&body(row)!==body(original))throw invalid('资料元数据未匹配当前保留正文，未替用旧批次。',{code:'MEMORY_CURRENT_VIEW_SOURCE_ENRICHMENT_MISMATCH',path:'/source_snapshot/documents/'+index});
    const enriched=Object.assign({},...matching,original);
    return {...enriched,text:body(original),content:body(original),source_snapshot_ref:b.source_snapshot_ref};
  });
  const graph={library_id:currentView.library_id,source_snapshot_ref:b.source_snapshot_ref,library_revision_ref:b.library_revision_ref,index_scope_run_id:b.index_scope_run_id,index_revision:b.knowledge_index_revision,domain_graph:currentView.domain_graph,knowledge:currentView.knowledge};
  const model=projectLightogReading({libraryId:currentView.library_id,currentView,graph,documents:retained,blocks,sources:[]});
  // These are the extracted reader's actual pin names. build_run_id denotes the
  // index namespace here, and must never be used to call a native document run.
  const scope={library_id:currentView.library_id,build_run_id:b.index_scope_run_id,library_revision_ref:b.library_revision_ref,graph_revision_ref:b.graph_revision_ref,source_snapshot_ref:b.source_snapshot_ref,source_index_revision:b.source_index_revision,fact_index_revision:b.knowledge_index_revision,publication_commit_ref:b.commit_ref,publication_confirmation_ref:b.confirmation_ref};
  const revision_key=JSON.stringify([currentView.library_id,...['index_scope_run_id','source_snapshot_ref','library_revision_ref','record_sha256','graph_revision_ref','source_index_revision','knowledge_index_revision','commit_ref','confirmation_ref'].map(key=>b[key])]);
  return {model,graph,scope,revision_key,currentView};
}

/** Optional independently signed read sidecar. The confirmed DTO and raw graph are never replaced. */
export async function projectLightogMemoryDisplayView(dto,options={}){
  const projection=projectLightogMemoryCurrentView(dto,options);
  if(!dto.temporal_projection)return projection;
  const {createTemporalDisplay}=await import('./lightog-temporal-display-v1.mjs');
  const display=await createTemporalDisplay(dto);
  return {...projection,model:attachLightogTemporalDisplay(projection.model,display),
    display_graph:display?.status==='READY'?display.graph:null,display_projection:display,
    revision_key:JSON.stringify([projection.revision_key,'DISPLAY',display?.status==='READY'?display.projection_sha256:'UNAVAILABLE'])};
}
