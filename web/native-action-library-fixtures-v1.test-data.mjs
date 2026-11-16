/** Reuses the parent's public authored engineering examples. Not EXH inputs or independent gold. */
import {hash} from './cq-discovery-store-v2.mjs';
import {actionExampleSources} from './native-action-fixtures-v1.test-data.mjs';
import {bindNativeActionSource} from './native-action-adapter-v1.mjs';
import {prepareNativeActionBatch} from './native-action-contract-v1.mjs';
import {buildNativeActionProcess} from './native-action-process-v1.mjs';
import {projectNativeActionDomain} from './native-action-domain-adapter-v1.mjs';
import {ACTION_PROCESSING_SCHEMA} from './native-action-processing-host-v1.mjs';

export function makeActionLibraryFixture({core,libraryId}) {
  const rawRecords=[0,1,2].map(index=>{
    const source=actionExampleSources[index],receipt=core.saveRecord({text:source.text,source:{kind:source.kind,metadata:source.metadata??{}}},
      {idempotency_key:'fixture-source-'+index});
    return core.getRawRecord(receipt.record_ref);
  });
  const sources=rawRecords.map(bindNativeActionSource);
  function batch(requestId,rows){
    const semantics=rows.map((row,index)=>({semantic_ref:'S'+(index+1),library_id:libraryId,text:row.text,
      ...(row.business.action_phase?{action_phase:row.business.action_phase}:{}),
      evidence:[{source_record_ref:sources[row.source].source_record_ref,revision:sources[row.source].revision,quote:sources[row.source].text}]}));
    return prepareNativeActionBatch({libraryId,requestId,sourceRecords:sources,semanticItems:semantics,
      proposals:rows.map((row,index)=>({local_ref:requestId+'-'+index,category:row.category,text:row.text,business:row.business,
        semantic_refs:[semantics[index].semantic_ref],conditions:row.conditions??[],time_text:row.time_text??null}))}).drafts;
  }
  const initial=batch('initial',[
    {source:0,category:'state',text:'泵P7低负载时渗漏2mL/h。',business:{subject:'泵 P7',property:'渗漏',value:2,unit:'mL/h'},conditions:['低负载']},
    {source:0,category:'action',text:'计划更换密封，尚未动手。',business:{subject:'泵 P7',action_phase:'PLANNED'},time_text:'11月14日'},
    {source:1,category:'action',text:'技师林完成泵P7密封更换，步骤成功，尚未复测。',business:{subject:{name:'泵 P7',type:'设备'},action_phase:'COMPLETED',
      participants:[{role:'执行者',entity:{name:'技师林',type:'人'}},{role:'作用对象',entity:{name:'泵 P7',type:'设备'}}],execution_result:'步骤成功',effect_gap:'尚未复测'},time_text:'11月15日'},
  ]);
  const feedback=batch('feedback',[
    {source:2,category:'observation',text:'更换后24小时低负载复测，渗漏仍2mL/h。',business:{subject:{name:'泵 P7',type:'设备'},property:'渗漏',value:2,unit:'mL/h',method:'复测',comparison:'无变化'},conditions:['低负载'],time_text:'更换后24小时'},
    {source:2,category:'observation',text:'噪声由60升至64dB。',business:{subject:{name:'泵 P7',type:'设备'},property:'噪声',before:60,value:64,unit:'dB',reported_cost:'噪声升高'}},
    {source:2,category:'evaluation',text:'工程师称未达标，标准未给出。',business:{evaluator:'工程师',verdict:'未达标',criteria:null}},
    {source:2,category:'process',text:'检修单MAINT/42的更换与复测过程。',business:{label:'检修单 MAINT/42',process_key:'MAINT/42'}},
  ]);
  const definitions=[['BEFORE_ACTION',initial[0],initial[2]],['REALIZES_PLAN',initial[2],initial[1]],
    ['AFTER_ACTION',feedback[0],initial[2]],['AFTER_ACTION',feedback[1],initial[2]],['EVALUATION_OF',feedback[2],feedback[0]],['MEMBER_OF',feedback[0],feedback[3]]];
  function linksFor(specs,nodes){
    const bindings=specs.map(([type,from,to],index)=>({library_id:libraryId,binding_ref:'binding-'+index,kind:'EXPLICIT_REFERENCE',
      from_ref:from.draft_ref,to_ref:to.draft_ref,semantic_ref:from.semantic_lineage[0].semantic_ref,origin:'AUTHORED_TEST_REFERENCE'}));
    return buildNativeActionProcess({libraryId,nodes:nodes.map(draft=>({ref:draft.draft_ref,draft})),referenceBindings:bindings,
      associations:specs.map(([type,from,to],index)=>({type,from_ref:from.draft_ref,to_ref:to.draft_ref,basis:{binding_ref:bindings[index].binding_ref}}))}).links;
  }
  const firstLinks=linksFor(definitions.slice(0,2),initial);
  function prepared(drafts,links,contextKnowledge,record){
    const projection=projectNativeActionDomain({libraryId,drafts,links,contextKnowledge,sourceRecords:sources});
    const body={schema:ACTION_PROCESSING_SCHEMA,library_id:libraryId,source_record_ref:record.record_ref,source_record_version:record.version,
      run_id:'authored-projection-fixture-'+record.record_ref,execution_mode:'DI_SCRIPTED',publication_eligible:false,
      skill_bindings:[],invocations:[],windows:[],...projection,retained:[],semantic_quality:'UNASSESSED'};
    return {...body,prepared_sha256:hash(body)};
  }
  const first=prepared(initial,firstLinks,[],rawRecords[1]);
  const second=prepared(feedback,linksFor(definitions.slice(2),[...initial,...feedback]),first.knowledge,rawRecords[2]);
  const legacy={record_ref:'legacy-knowledge',knowledge_ref:'legacy-knowledge',library_id:libraryId,kind:'RELATION',text:'旧档案包含旧附件。',
    statement:'旧档案包含旧附件。',subject_ref:'legacy-archive',object_ref:'legacy-attachment',predicate:'包含',participants:[],
    semantic_policy:'DOMAIN_KNOWLEDGE_V1',general_knowledge_policy:'GENERAL_KNOWLEDGE_V1',source_refs:[{doc_ref:'authored-legacy-doc',revision:'r1'}],
    evidence:[],evidence_refs:[],conditions:[],domain:{entities:[{id:'legacy-archive',name:'旧档案',kind:'ENTITY',entity_type:'档案'},
      {id:'legacy-attachment',name:'旧附件',kind:'ENTITY',entity_type:'附件'}],definition:null,relation:null}};
  return {rawRecords,sources,first,second,legacy};
}
