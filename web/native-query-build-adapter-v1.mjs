/** Read-only bridge from existing build artifacts to an independent query reader. */
import {canonical,hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createNativeQueryView} from './native-query-view-v1.mjs';

const POLICY='native-local-adoption-v1';

export function createNativeBuildQueryReader({store,catalog,libraryId,snapshotId,build=null,originRunRef=null}){
  need(store&&catalog&&typeof catalog.get==='function'&&typeof catalog.isCurrent==='function'&&textField(libraryId)&&textField(snapshotId),'QUERY_BUILD_ADAPTER_PORT_REQUIRED');
  const source=catalog.get(snapshotId,libraryId);need(source&&Array.isArray(source.documents),'QUERY_BUILD_SOURCE_REQUIRED');
  const initial=build?.snapshot()??null,runRef=originRunRef??initial?.run_id??null;
  const scopeKey=runRef?canonical([libraryId,snapshotId,runRef]):null;
  function payload(view){
    if(!scopeKey)return null;
    const prefix='native_'+(view==='SOURCE'?'source':'fact')+'_index_';
    const head=store.getRecord(prefix+'head_v1',scopeKey);if(!head)return null;
    const body=store.getRecord(prefix+'payload_v1',head.payload_ref);
    need(body&&hash(body)===head.payload_sha256&&body.index_revision===head.index_revision,'QUERY_BUILD_INDEX_CHANGED');
    need(body.scope?.library_id===libraryId&&body.scope?.source_snapshot_ref===snapshotId&&body.scope?.run_id===runRef&&body.view===view,'QUERY_BUILD_INDEX_SCOPE_INVALID');
    need(hash(body.records)===body.manifest?.record_set_sha256&&body.manifest?.status==='READY','QUERY_BUILD_MANIFEST_INVALID');
    return {head,body};
  }
  const sourceIndex=payload('SOURCE'),factIndex=build?payload('ADOPTED_FACT'):null;
  const initialAdoption=initial?.adoption?.adoption_revision_ref??null;
  if(factIndex){
    need(build&&initial?.adoption?.policy===POLICY&&initialAdoption===factIndex.body.adoption_revision_ref,'QUERY_BUILD_ADOPTION_BINDING_INVALID');
    // A new pending review cannot promote its candidates. The public adoption
    // snapshot still exposes only the previously confirmed effective facts.
  }
  const spaces=new Map();
  const attach=(record,index)=>{
    const space=index?.body.embedding_space,values=space&&index.body.vectors?.[hash(record.text)];
    if(!space||!values)return {};
    const space_ref='query_space_'+hash(space),binding={...clone(space),space_ref};spaces.set(space_ref,binding);
    return {embedding:{space_ref,values:clone(values),text_sha256:hash(record.text)}};
  };
  let fallbackBlocks=0,indexedBlocks=0;
  const documents=source.documents.map(d=>{
    const doc_ref=d.doc_ref??d.doc_id;let blocks=(d.blocks??[]).map(b=>({...clone(b),block_ref:b.block_ref??b.block_id}));
    if(!blocks.length&&d.content.length)blocks=[{block_ref:'canonical_whole_'+hash([doc_ref,d.revision]),start:0,end:d.content.length}];
    const records=sourceIndex?.body.records.filter(r=>r.source_refs?.length===1&&r.source_refs[0].doc_ref===doc_ref&&r.source_refs[0].revision===d.revision)??[];
    if(records.length){
      const indexed=records.map(r=>{
        const spans=r.source_spans??r.evidence??[];
        need(spans.length>0,'QUERY_BUILD_SOURCE_SPANS_REQUIRED');
        const start=Math.min(...spans.map(s=>s.start)),end=Math.max(...spans.map(s=>s.end));
        need(d.content.slice(start,end)===r.text,'QUERY_BUILD_SOURCE_TEXT_CHANGED');
        return {block_ref:r.record_ref,start,end,...attach(r,sourceIndex)};
      });
      // An index head may cover only some source spans. Subtract those spans
      // from canonical blocks so every remaining original span is searchable.
      const covered=indexed.map(b=>[b.start,b.end]).sort((a,b)=>a[0]-b[0]);
      const fallback=blocks.flatMap(block=>{
        let pieces=[[block.start,block.end]];
        for(const [start,end]of covered)pieces=pieces.flatMap(([a,b])=>end<=a||start>=b?[[a,b]]:[[a,Math.min(start,b)],[Math.max(end,a),b]].filter(([x,y])=>y>x));
        return pieces.map(([start,end])=>({block_ref:block.block_ref+'_lexical_'+start+'_'+end,start,end}));
      });
      indexedBlocks+=indexed.length;fallbackBlocks+=fallback.length;blocks=[...indexed,...fallback];
    }else fallbackBlocks+=blocks.length;
    return {doc_ref,revision:d.revision,title:d.title??doc_ref,content:d.content,state:d.state??'ACTIVE',blocks,parser:d.parser??null};
  });
  function assertSource(){
    need(catalog.isCurrent(snapshotId,libraryId)===true,'QUERY_BUILD_SOURCE_STALE');
    if(build){
      const state=build.snapshot();need(state.source_current!==false,'QUERY_BUILD_SOURCE_STALE');
      need((state.adoption?.adoption_revision_ref??null)===initialAdoption,'QUERY_BUILD_ADOPTION_STALE');
    }
    for(const [view,before]of [['SOURCE',sourceIndex],['ADOPTED_FACT',factIndex]]){
      if(view==='ADOPTED_FACT'&&!build)continue;
      const after=payload(view);need((after?.head.index_revision??null)===(before?.head.index_revision??null),'QUERY_BUILD_INDEX_STALE');
    }
    return true;
  }
  function readFacts(){
    assertSource();if(!factIndex)return [];
    const snapshot=build.snapshot(),adoption=snapshot.adoption;
    need(adoption?.policy===POLICY&&adoption.adoption_revision_ref===initialAdoption,'QUERY_BUILD_ADOPTION_STALE');
    const effective=new Map((adoption.facts??[]).filter(f=>f.policy===POLICY&&f.representation==='ADOPTED_FACT').map(f=>[f.fact_ref,f]));
    // build.graph is the public eligibility read path: in-index suspended facts are absent.
    const graph=build.graph({view:'ADOPTED_FACT'}),allowed=new Set((graph.nodes??[]).filter(n=>n.kind==='ADOPTED_FACT').map(n=>n.fact_ref));
    return factIndex.body.records.filter(r=>effective.has(r.fact_ref)&&allowed.has(r.fact_ref)).map(r=>{
      const fact=effective.get(r.fact_ref);
      need(fact.policy===POLICY&&fact.representation==='ADOPTED_FACT','QUERY_BUILD_FACT_POLICY_INVALID');
      return {...clone(fact),evidence:clone(r.evidence),...attach(r,factIndex)};
    });
  }
  // Populate fact model-space metadata even before the first actual search.
  if(factIndex)for(const f of factIndex.body.records)attach(f,factIndex);
  const rawSubjects=initial?.scope?.subjects??[],factsForProfiles=initial?.adoption?.facts??[];
  const profileMap=new Map(rawSubjects.map(s=>[s.subject_ref,s]));
  for(const f of factsForProfiles)for(const p of f.participant_profiles??[])if(!profileMap.has(p.subject_ref))profileMap.set(p.subject_ref,p);
  for(const task of initial?.scope?.tasks??[])if(task.scope_kind==='MODULE_OR_DOCUMENT'&&!profileMap.has(task.task_ref))profileMap.set(task.task_ref,{subject_ref:task.task_ref,surface:task.module??task.requirement??task.task_ref,source_refs:task.source_refs??[]});
  const subjects=[...profileMap.values()].filter(s=>textField(s.subject_ref)&&textField(s.surface??s.name)).map(s=>({subject_ref:s.subject_ref,surface:s.surface??s.name,aliases:clone(s.aliases??[]),source_refs:clone(s.source_refs??[]),evidence:[]}));
  const metadata={source_capability:sourceIndex?.body.capability??'LEXICAL',source_index_coverage:indexedBlocks?(fallbackBlocks?'PARTIAL':'COMPLETE'):'NONE',fact_capability:factIndex?.body.capability??'UNAVAILABLE',embedding_spaces:[...spaces.values()],adoption_revision_ref:initialAdoption,source_index_revision:sourceIndex?.head.index_revision??null,fact_index_revision:factIndex?.head.index_revision??null};
  return createNativeQueryView({store,libraryId,sourceSnapshot:{source_snapshot_ref:snapshotId,source_epoch:source.source_epoch,documents},subjects,...(factIndex?{readFacts}:{}),isCurrent:()=>{try{return assertSource();}catch(error){throw error;}},metadata});
}

/** Library pointer selection is explicit CAS, independent of build run timestamps. */
export function createNativeQueryRegistry({store,resolveReader}){
  need(store&&typeof resolveReader==='function','QUERY_REGISTRY_PORT_REQUIRED');
  return {
    async register({libraryId,exportRef,sourceSnapshotRef,expectedManifestRef=null}){
      need([libraryId,exportRef,sourceSnapshotRef].every(textField),'QUERY_REGISTRY_INPUT_INVALID');
      const reader=await resolveReader({library_id:libraryId,export_ref:exportRef,source_snapshot_ref:sourceSnapshotRef});reader.assertCurrent();
      need(reader.scope().library_id===libraryId&&reader.scope().source_snapshot_ref===sourceSnapshotRef,'QUERY_REGISTRY_READER_MISMATCH');
      return store.transaction(()=>{
        reader.assertCurrent();
        const previous=store.getRecord('native_query_library_head_v1',libraryId);
        need((previous?.manifest_ref??null)===expectedManifestRef,'QUERY_REGISTRY_CAS_MISMATCH');
        const body={library_id:libraryId,export_ref:exportRef,source_snapshot_ref:sourceSnapshotRef,reader_manifest_ref:reader.scope().manifest_ref};
        const record={...body,manifest_ref:'native-query-library:'+hash(body),parent_manifest_ref:previous?.manifest_ref??null};
        store.putRecord('native_query_library_head_v1',libraryId,record);return record;
      });
    },
    async open(libraryId){
      const head=store.getRecord('native_query_library_head_v1',libraryId);need(head,'QUERY_LIBRARY_VIEW_NOT_READY');
      const reader=await resolveReader(clone(head));reader.assertCurrent();
      need(reader.scope().library_id===libraryId&&reader.scope().source_snapshot_ref===head.source_snapshot_ref&&reader.scope().manifest_ref===head.reader_manifest_ref,'QUERY_REGISTRY_READER_MISMATCH');
      function assertCurrent(){
        need(store.getRecord('native_query_library_head_v1',libraryId)?.manifest_ref===head.manifest_ref,'QUERY_LIBRARY_MANIFEST_STALE');
        reader.assertCurrent();need(reader.scope().manifest_ref===head.reader_manifest_ref,'QUERY_REGISTRY_READER_MISMATCH');return true;
      }
      const view={assertCurrent,scope(){assertCurrent();return {...reader.scope(),reader_manifest_ref:head.reader_manifest_ref,manifest_ref:head.manifest_ref};}};
      for(const key of ['documents','subjects','facts','evidence','sourceEvidence'])if(typeof reader[key]==='function')view[key]=(...args)=>{assertCurrent();return reader[key](...args);};
      assertCurrent();return Object.freeze(view);
    }
  };
}
