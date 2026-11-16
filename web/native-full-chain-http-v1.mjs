import {NATIVE_ARTIFACT_KINDS,NATIVE_ARTIFACT_PAGE_LIMIT} from './native-build-artifacts-read-v1.mjs';
/** Versioned product endpoints. Reading a run never starts or resumes it. */
export const NATIVE_BUILD_MODE = 'NATIVE_CQ_BUILD_V1';
const need=(ok,code,status=400)=>{if(!ok)throw Object.assign(Error(code),{code,status});};
const fields=(value,keys)=>need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),'NATIVE_HTTP_ARGUMENTS_INVALID');
export function createNativeFullChainHttp({host,json,parseBody}) {
  return async function handle({req,res,pathname}) {
    const route=pathname.match(/^\/api\/product\/libraries\/(kb_[a-f0-9-]{36})\/native-full-chain\/runs(?:\/([A-Za-z0-9_-]{1,160})(?:\/(status|graph|query|semantic-packages|artifacts|library-review|saved-stage-recovery|conflicts)(?:\/(decisions|applications|preview|analysis))?)?)?$/);
    if(!route)return false;
    need(host,'NATIVE_BUILD_NOT_CONNECTED',409);
    const [,libraryId,runId,action,reviewAction]=route;need(!reviewAction||action==='library-review','NATIVE_HTTP_ARGUMENTS_INVALID');
    if(!runId&&req.method==='GET'){json(res,200,await host.list({libraryId}));return true;}
    if(!runId&&req.method==='POST'){
      const body=await parseBody(req);fields(body,['request_id','consent','limits','capability','allow_format_repair_once','reuse_cq_family_from_run_id','reuse_extraction_from_run_id','stop_after','reuse_cq_from_run_id','acknowledge_unknown','reuse_cq_drafts_from_run_id','rebuild_saved_proposals_from_run_id','reuse_semantic_from_run_id','unknown_acknowledgement_ref','reuse_organization_draft_from_run_id','resume_from_run_id','settled_semantic_import_ref','build_flow_policy','settled_cq_import_ref','recover_simplified_from_run_id']);
      need(body.settled_cq_import_ref===undefined||/^settled_cq_import_[a-f0-9]{64}$/.test(body.settled_cq_import_ref),'NATIVE_CQ_IMPORT_REF_INVALID');
      need(body.build_flow_policy===undefined||body.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1','NATIVE_BUILD_FLOW_POLICY_INVALID');
      need(body.resume_from_run_id===undefined||typeof body.resume_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.resume_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.settled_semantic_import_ref===undefined||typeof body.settled_semantic_import_ref==='string'&&/^settled_semantic_import_[a-f0-9]{64}$/.test(body.settled_semantic_import_ref),'NATIVE_SETTLED_IMPORT_REF_INVALID');
      need(body.consent===true,'NATIVE_BUILD_CONSENT_REQUIRED',428);
      need(/^[a-f0-9-]{36}$/.test(body.request_id??''),'NATIVE_REQUEST_ID_REQUIRED');
      need(body.allow_format_repair_once===undefined||typeof body.allow_format_repair_once==='boolean','NATIVE_FORMAT_REPAIR_POLICY_INVALID');
      need(body.stop_after===undefined||body.stop_after==='FAMILY','NATIVE_STOP_AFTER_INVALID');
      need(body.reuse_semantic_from_run_id===undefined||typeof body.reuse_semantic_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_semantic_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.reuse_organization_draft_from_run_id===undefined||typeof body.reuse_organization_draft_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_organization_draft_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.rebuild_saved_proposals_from_run_id===undefined||typeof body.rebuild_saved_proposals_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.rebuild_saved_proposals_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.reuse_cq_drafts_from_run_id===undefined||typeof body.reuse_cq_drafts_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_cq_drafts_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.reuse_cq_from_run_id===undefined||typeof body.reuse_cq_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_cq_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.acknowledge_unknown===undefined||typeof body.acknowledge_unknown==='boolean','NATIVE_UNKNOWN_ACKNOWLEDGEMENT_INVALID');
      need(body.unknown_acknowledgement_ref===undefined||typeof body.unknown_acknowledgement_ref==='string'&&/^native_unknown_ack_[a-f0-9]{64}$/.test(body.unknown_acknowledgement_ref),'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_INVALID');
      need(body.reuse_cq_family_from_run_id===undefined||typeof body.reuse_cq_family_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_cq_family_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      need(body.reuse_extraction_from_run_id===undefined||typeof body.reuse_extraction_from_run_id==='string'&&/^nrun_[a-f0-9]{32}$/.test(body.reuse_extraction_from_run_id),'NATIVE_REUSE_RUN_ID_INVALID');
      json(res,202,await host.start({libraryId,requestId:body.request_id,...(body.recover_simplified_from_run_id?{recoverSimplifiedFromRunId:body.recover_simplified_from_run_id}:{}),...(body.settled_cq_import_ref?{settledCQImportRef:body.settled_cq_import_ref}:{}),...(body.build_flow_policy?{buildFlowPolicy:body.build_flow_policy}:{}),...(body.settled_semantic_import_ref?{settledSemanticImportRef:body.settled_semantic_import_ref}:{}),...(body.resume_from_run_id?{resumeFromRunId:body.resume_from_run_id}:{}),limits:body.limits,capability:body.capability??'HYBRID',allowFormatRepairOnce:body.allow_format_repair_once??false,...(body.reuse_semantic_from_run_id?{reuseSemanticFromRunId:body.reuse_semantic_from_run_id}:{}),...(body.reuse_organization_draft_from_run_id?{reuseOrganizationDraftFromRunId:body.reuse_organization_draft_from_run_id}:{}),...(body.unknown_acknowledgement_ref===undefined?{}:{unknownAcknowledgementRef:body.unknown_acknowledgement_ref}),...(body.rebuild_saved_proposals_from_run_id?{rebuildSavedProposalsFromRunId:body.rebuild_saved_proposals_from_run_id}:{}),...(body.stop_after?{stopAfter:body.stop_after}:{}),...(body.reuse_cq_from_run_id?{reuseCQFromRunId:body.reuse_cq_from_run_id}:{}),...(body.reuse_cq_drafts_from_run_id?{reuseCQDraftsFromRunId:body.reuse_cq_drafts_from_run_id}:{}),...(body.acknowledge_unknown===undefined?{}:{acknowledgeUnknown:body.acknowledge_unknown}),...(body.reuse_cq_family_from_run_id?{reuseCQFamilyFromRunId:body.reuse_cq_family_from_run_id}:{}),...(body.reuse_extraction_from_run_id?{reuseExtractionFromRunId:body.reuse_extraction_from_run_id}:{})}));return true;
    }
    if(runId&&(!action||action==='status')&&req.method==='GET'){json(res,200,await host.status({libraryId,runId}));return true;}
    if(action==='conflicts'){
      if(req.method==='GET'){json(res,200,await host.conflicts({libraryId,runId,operation:'review'}));return true;}
      if(req.method==='POST'){const body=await parseBody(req);fields(body,['consent','operation','request_id','item_ref','action','reason','selected_ref','valid_times','created_at','decision_refs','application_ref','expected_binding','expected_revision_ref','expected_revision_sha256']);need(body.consent===true,'NATIVE_BUILD_CONSENT_REQUIRED',428);need(['preview','decide','prepare','apply','confirm','history','revoke'].includes(body.operation),'NATIVE_CONFLICT_OPERATION_INVALID');json(res,200,await host.conflicts({libraryId,runId,...body}));return true;}
      need(false,'NATIVE_METHOD_NOT_ALLOWED',405);
    }
    if(action==='saved-stage-recovery'){
      if(req.method==='GET'){json(res,200,await host.savedStageRecovery({libraryId,runId}));return true;}
      if(req.method==='POST'){const body=await parseBody(req);fields(body,['request_id','consent']);need(body.consent===true,'NATIVE_BUILD_CONSENT_REQUIRED',428);need(/^[a-f0-9-]{36}$/.test(body.request_id??''),'NATIVE_REQUEST_ID_REQUIRED');json(res,202,await host.recoverSavedStages({libraryId,runId,requestId:body.request_id}));return true;}
      need(false,'NATIVE_METHOD_NOT_ALLOWED',405);
    }
    if(action==='library-review'){
      if(reviewAction==='analysis'){
        if(req.method==='GET'){
          const search=new URL(req.url,'http://localhost').searchParams;
          need([...search.keys()].every(key=>['revision_ref','item_ref','request_id'].includes(key)&&search.getAll(key).length===1),'NATIVE_HTTP_ARGUMENTS_INVALID');
          const revisionRef=search.get('revision_ref'),itemRef=search.get('item_ref'),requestId=search.get('request_id');
          need(typeof revisionRef==='string'&&revisionRef.length>0&&revisionRef.length<=512,'NATIVE_LIBRARY_REVIEW_REVISION_REQUIRED');
          need(typeof itemRef==='string'&&itemRef.length>0&&itemRef.length<=512,'NATIVE_LIBRARY_REVIEW_ITEM_REQUIRED');
          need(/^[a-f0-9-]{36}$/.test(requestId??''),'NATIVE_REQUEST_ID_REQUIRED');
          json(res,200,await host.libraryReviewAnalysis({libraryId,runId,revisionRef,itemRef,requestId}));return true;
        }
        if(req.method==='POST'){
          const body=await parseBody(req);fields(body,['request_id','revision_ref','item_ref']);
          need(/^[a-f0-9-]{36}$/.test(body.request_id??''),'NATIVE_REQUEST_ID_REQUIRED');
          need(typeof body.revision_ref==='string'&&body.revision_ref.length>0&&body.revision_ref.length<=512,'NATIVE_LIBRARY_REVIEW_REVISION_REQUIRED');
          need(typeof body.item_ref==='string'&&body.item_ref.length>0&&body.item_ref.length<=512,'NATIVE_LIBRARY_REVIEW_ITEM_REQUIRED');
          json(res,202,await host.analyzeLibraryReview({libraryId,runId,revisionRef:body.revision_ref,itemRef:body.item_ref,requestId:body.request_id}));return true;
        }
        need(false,'NATIVE_METHOD_NOT_ALLOWED',405);
      }
      if(req.method==='GET'&&reviewAction==='preview'){const search=new URL(req.url,'http://localhost').searchParams;need([...search.keys()].every(k=>k==='revision_ref'&&search.getAll(k).length===1),'NATIVE_HTTP_ARGUMENTS_INVALID');const revisionRef=search.get('revision_ref');need(typeof revisionRef==='string'&&revisionRef.length>0&&revisionRef.length<=512,'NATIVE_LIBRARY_REVIEW_REVISION_REQUIRED');json(res,200,await host.previewLibraryReview({libraryId,runId,revisionRef}));return true;}
      if(req.method==='GET'&&!reviewAction){const search=new URL(req.url,'http://localhost').searchParams;need([...search.keys()].every(k=>k==='revision_ref'&&search.getAll(k).length===1),'NATIVE_HTTP_ARGUMENTS_INVALID');const revisionRef=search.get('revision_ref')??undefined;need(revisionRef===undefined||revisionRef.length>0&&revisionRef.length<=512,'NATIVE_LIBRARY_REVIEW_REVISION_REQUIRED');json(res,200,await host.libraryReview({libraryId,runId,revisionRef}));return true;}
      if(req.method==='POST'&&['decisions','applications'].includes(reviewAction)){
        const body=await parseBody(req);
        fields(body,reviewAction==='decisions'?['request_id','revision_ref','item_ref','action','reason','correction','definition_resolution']:['request_id','revision_ref','application_ref']);
        need(/^[a-f0-9-]{36}$/.test(body.request_id??''),'NATIVE_REQUEST_ID_REQUIRED');
        need(typeof body.revision_ref==='string'&&body.revision_ref.length>0&&body.revision_ref.length<=512,'NATIVE_LIBRARY_REVIEW_REVISION_REQUIRED');
        if(reviewAction==='decisions'){
          need(typeof body.item_ref==='string'&&typeof body.action==='string'&&(body.reason===undefined||typeof body.reason==='string'),'NATIVE_LIBRARY_REVIEW_DECISION_INVALID');
          need(body.correction===undefined||body.correction&&typeof body.correction==='object'&&!Array.isArray(body.correction),'NATIVE_LIBRARY_REVIEW_CORRECTION_INVALID');
          if(body.definition_resolution!==undefined){
            fields(body.definition_resolution,['comparison_ref','selected_definition_ref']);
            need(typeof body.definition_resolution.comparison_ref==='string'&&body.definition_resolution.comparison_ref.length>0&&body.definition_resolution.comparison_ref.length<=512,'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
            need(body.definition_resolution.selected_definition_ref===undefined||typeof body.definition_resolution.selected_definition_ref==='string'&&body.definition_resolution.selected_definition_ref.length>0&&body.definition_resolution.selected_definition_ref.length<=512,'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
          }
          json(res,200,await host.decideLibraryReview({libraryId,runId,revisionRef:body.revision_ref,requestId:body.request_id,itemRef:body.item_ref,action:body.action,reason:body.reason??'',...(body.correction===undefined?{}:{correction:body.correction}),...(body.definition_resolution===undefined?{}:{definitionResolution:body.definition_resolution})}));
        }else{
          need(body.application_ref===undefined||typeof body.application_ref==='string'&&body.application_ref.length>0&&body.application_ref.length<=512,'NATIVE_LIBRARY_REVIEW_APPLICATION_INVALID');
          json(res,202,await host.applyLibraryReview({libraryId,runId,revisionRef:body.revision_ref,requestId:body.request_id,...(body.application_ref===undefined?{}:{applicationRef:body.application_ref})}));
        }
        return true;
      }
      need(false,'NATIVE_METHOD_NOT_ALLOWED',405);
    }
    if(action==='artifacts'&&req.method==='GET'){
      const search=new URL(req.url,'http://localhost').searchParams;
      need([...search.keys()].every(k=>['kind','after','limit','doc_ref','ref'].includes(k)&&search.getAll(k).length===1),'NATIVE_HTTP_ARGUMENTS_INVALID');
      const kind=search.get('kind');need(NATIVE_ARTIFACT_KINDS.includes(kind),'NATIVE_ARTIFACT_KIND_INVALID');
      const integer=(name,fallback)=>{const raw=search.get(name);need(raw===null||/^(0|[1-9][0-9]*)$/.test(raw),'NATIVE_ARTIFACT_PAGE_INVALID');const n=raw===null?fallback:Number(raw);need(Number.isSafeInteger(n),'NATIVE_ARTIFACT_PAGE_INVALID');return n;};
      const after=integer('after',0),limit=integer('limit',40),docRef=search.get('doc_ref'),ref=search.get('ref');
      need(limit>=1&&limit<=NATIVE_ARTIFACT_PAGE_LIMIT,'NATIVE_ARTIFACT_PAGE_INVALID');
      need((docRef===null||docRef.length>0&&docRef.length<=512)&&(ref===null||ref.length>0&&ref.length<=1024),'NATIVE_ARTIFACT_SELECTION_INVALID');
      json(res,200,await host.artifacts({libraryId,runId,kind,after,limit,docRef,ref}));return true;
    }
    if(action==='semantic-packages'&&req.method==='GET'){
      const search=new URL(req.url,'http://localhost').searchParams;
      need([...search.keys()].every(k=>['window_ref','after','offset','max_chars'].includes(k)),'NATIVE_HTTP_ARGUMENTS_INVALID');
      const windowRef=search.get('window_ref');need(typeof windowRef==='string'&&windowRef.length>0&&windowRef.length<=512,'NATIVE_SEMANTIC_WINDOW_REQUIRED');
      const integer=(name,fallback)=>{const raw=search.get(name);need(raw===null||/^(0|[1-9][0-9]*)$/.test(raw),'NATIVE_SEMANTIC_PAGE_INVALID');const n=raw===null?fallback:Number(raw);need(Number.isSafeInteger(n),'NATIVE_SEMANTIC_PAGE_INVALID');return n;};
      const after=integer('after',0),offset=integer('offset',0),maxChars=integer('max_chars',6000);need(maxChars>=256&&maxChars<=12000,'NATIVE_SEMANTIC_PAGE_INVALID');
      json(res,200,await host.semanticPackage({libraryId,runId,windowRef,after,offset,maxChars}));return true;
    }
    if(action==='graph'&&req.method==='GET'){
      const view=new URL(req.url,'http://localhost').searchParams.get('view');
      need(view===null||['SOURCE','ADOPTED_FACT','EXTRACTED_KNOWLEDGE'].includes(view),'NATIVE_VIEW_INVALID');
      json(res,200,await host.graph({libraryId,runId,...(view===null?{}:{view})}));return true;
    }
    if(action==='query'&&req.method==='POST'){
      const body=await parseBody(req);fields(body,['view','query','limit','vector','embedding_space']);
      need(body.view===undefined||['SOURCE','ADOPTED_FACT','EXTRACTED_KNOWLEDGE'].includes(body.view),'NATIVE_VIEW_INVALID');
      need(typeof body.query==='string'&&body.query.trim()&&body.query.length<=4096,'NATIVE_QUERY_INVALID');
      need(body.limit===undefined||Number.isInteger(body.limit)&&body.limit>0&&body.limit<=100,'NATIVE_QUERY_LIMIT_INVALID');
      need(body.vector===undefined||Array.isArray(body.vector)&&body.vector.length>0&&body.vector.length<=32768&&body.vector.every(Number.isFinite),'NATIVE_QUERY_VECTOR_INVALID');
      need(body.vector===undefined||body.embedding_space&&typeof body.embedding_space==='object'&&!Array.isArray(body.embedding_space),'NATIVE_QUERY_EMBEDDING_SPACE_REQUIRED');
      const {embedding_space,...query}=body;
      json(res,200,await host.query({libraryId,runId,...query,...(embedding_space?{embeddingSpace:embedding_space}:{})}));return true;
    }
    need(false,'NATIVE_METHOD_NOT_ALLOWED',405);
  };
}
