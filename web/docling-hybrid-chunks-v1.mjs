/** Shared source chunks produced by Docling, with an explicit tokenizer budget. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {cleanParserEnv,parserPython} from './runtime.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const VERSION='docling-hybrid-chunks/1';
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
const DOC_ID=/^[a-f0-9-]{36}$/;
export const DEFAULT_DOCLING_HYBRID_POLICY=Object.freeze({engine:'DoclingHybridChunker',max_tokens:8000,tokenizer:'cl100k_base',
  token_count_exact:true,model_tokenizer_match:'NOT_ASSERTED',merge_peers:true,repeat_table_header:true,
  always_emit_headings:true,
  budget_scope:'CONTEXTUALIZED_SOURCE_TEXT',source_mapping:'DOCLING_ITEM_REFERENCES',
  window_composition:'ADJACENT_NATIVE_CHUNKS_WITHIN_DOCUMENT_V1'});

function retainedSource(doc,storage){
  const sourceId=doc.parser?.document_id;
  need(doc.parser?.name==='docling'&&DOC_ID.test(sourceId??''),'HYBRID_CHUNK_DOCLING_DOCUMENT_REQUIRED');
  const dir=resolve(storage,sourceId),rawPath=join(dir,'docling.json'),parsedPath=join(dir,'parsed.json');
  need(existsSync(rawPath)&&existsSync(parsedPath),'HYBRID_CHUNK_RETAINED_DOCUMENT_REQUIRED');
  const rawBytes=readFileSync(rawPath),raw=JSON.parse(rawBytes),parsed=JSON.parse(readFileSync(parsedPath,'utf8'));
  need(raw.parser==='docling'&&raw.document&&Array.isArray(raw.blocks),'HYBRID_CHUNK_RETAINED_DOCUMENT_INVALID');
  need(parsed.document_id===sourceId&&parsed.content===doc.content&&bytesHash(parsed.content)===parsed.parsed_sha256&&
    parsed.parsed_sha256===doc.parser.parsed_sha256&&parsed.original_sha256===doc.parser.original_sha256&&
    hash(parsed.blocks)===hash(doc.blocks),'HYBRID_CHUNK_SOURCE_MISMATCH');
  const rawContent=raw.blocks.filter(b=>typeof b.text==='string'&&b.text.trim()).map(b=>b.text).join('\n\n');
  need(rawContent===parsed.content&&raw.blocks.filter(b=>typeof b.text==='string'&&b.text.trim()).every((b,i)=>
    b.block_id===parsed.blocks[i]?.block_id&&b.kind===parsed.blocks[i]?.kind&&b.text===parsed.content.slice(parsed.blocks[i].start,parsed.blocks[i].end)),
  'HYBRID_CHUNK_RAW_SOURCE_MISMATCH');
  const originalPath=join(dir,'original'+parsed.extension);
  need(existsSync(originalPath)&&bytesHash(readFileSync(originalPath))===parsed.original_sha256,'HYBRID_CHUNK_ORIGINAL_SOURCE_CHANGED');
  return {doc_ref:doc.doc_id,revision:doc.revision,raw_path:rawPath,raw_sha256:bytesHash(rawBytes),source_document_id:sourceId};
}

function runWorker(python,args,env){
  return new Promise((done,reject)=>{
    const child=spawn(python,args,{env,stdio:['ignore','ignore','pipe']});
    let failure='HYBRID_CHUNK_WORKER_FAILED',finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):done();};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Object.assign(Error('HYBRID_CHUNK_WORKER_TIMEOUT'),{code:'HYBRID_CHUNK_WORKER_TIMEOUT'}));},180000);
    child.stderr.on('data',bytes=>{const match=bytes.toString().match(/"error_code":\s*"([A-Z_]+)"/);if(match)failure=match[1];});
    child.on('error',()=>finish(Object.assign(Error('HYBRID_CHUNK_WORKER_UNAVAILABLE'),{code:'HYBRID_CHUNK_WORKER_UNAVAILABLE'})));
    child.on('close',code=>finish(code===0?null:Object.assign(Error(failure),{code:failure})));
  });
}

/** Reuse retained Docling JSON; no reparse, OCR, model, or embedding request. */
export async function createDoclingHybridChunkPlan({snapshot,documentStorage,maxTokens=8000,tokenizerName='cl100k_base',python=parserPython(),outputDirectory}={}){
  need(snapshot&&textField(snapshot.snapshot_id)&&Array.isArray(snapshot.documents)&&snapshot.documents.length>0,'HYBRID_CHUNK_SNAPSHOT_REQUIRED');
  need(textField(documentStorage)&&existsSync(python),'HYBRID_CHUNK_ENVIRONMENT_REQUIRED');
  need(Number.isSafeInteger(maxTokens)&&maxTokens>0&&tokenizerName==='cl100k_base','HYBRID_CHUNK_POLICY_INVALID');
  const seen=new Set();
  for(const doc of snapshot.documents){need(textField(doc.doc_id)&&!seen.has(doc.doc_id)&&textField(doc.revision)&&typeof doc.content==='string'&&Array.isArray(doc.blocks),'HYBRID_CHUNK_SOURCE_INVALID');seen.add(doc.doc_id);}
  const documents=snapshot.documents.map(doc=>retainedSource(doc,documentStorage));
  const scratch=mkdtempSync(join(tmpdir(),'lightog-hybrid-'));
  try{
    const requestPath=join(scratch,'request.json'),responsePath=join(scratch,'response.json');
    writeFileSync(requestPath,JSON.stringify({max_tokens:maxTokens,tokenizer_name:tokenizerName,documents}),{mode:0o600});
    const env={...cleanParserEnv(),TIKTOKEN_CACHE_DIR:resolve(ROOT,'local-runs/docling-models/tiktoken')};
    await runWorker(python,[resolve(ROOT,'web/docling_hybrid_chunk_worker.py'),requestPath,responsePath],env);
    const response=JSON.parse(readFileSync(responsePath,'utf8'));
    need(response.documents?.length===documents.length&&response.versions&&Array.isArray(response.tokenizer_data_sha256),'HYBRID_CHUNK_WORKER_OUTPUT_INVALID');
    const policy={...DEFAULT_DOCLING_HYBRID_POLICY,max_tokens:maxTokens,versions:response.versions,tokenizer_data_sha256:response.tokenizer_data_sha256,
      implementation_sha256:bytesHash(readFileSync(resolve(ROOT,'web/docling_hybrid_chunk_worker.py')))};
    const binding={version:VERSION,source_snapshot_ref:snapshot.snapshot_id,source_fingerprint:snapshot.fingerprint??hash(snapshot),policy,
      sources:documents.map(({raw_path,...source})=>source)};
    const plan_ref='hybrid_plan_'+hash(binding),chunks=[],windows=[],gaps=[],coverage=[],documentSummary=[];
    for(const [index,doc] of snapshot.documents.entries()){
      const row=response.documents[index];
      need(row.doc_ref===doc.doc_id&&row.revision===doc.revision&&Array.isArray(row.chunks),'HYBRID_CHUNK_WORKER_SOURCE_MISMATCH');
      const blocks=new Map(doc.blocks.map(b=>[b.block_id,b]));
      for(const item of row.chunks){
        need(Number.isSafeInteger(item.ordinal)&&typeof item.text==='string'&&typeof item.contextualized_text==='string'&&Number.isSafeInteger(item.token_count)&&item.token_count>=0&&Array.isArray(item.source_items)&&Array.isArray(item.headings),'HYBRID_CHUNK_WORKER_CHUNK_INVALID');
        const source_block_refs=[...new Set(item.source_items.flatMap(s=>[s.self_ref,...(s.parent_refs??[])]).filter(ref=>blocks.has(ref)))];
        const chunk_ref='hybrid_chunk_'+hash({plan_ref,doc_ref:doc.doc_id,revision:doc.revision,...item});
        const value={chunk_ref,plan_ref,doc_ref:doc.doc_id,revision:doc.revision,title:doc.title??'',...clone(item),source_block_refs,
          token_budget:maxTokens,tokenizer:tokenizerName,token_count_exact:true,model_tokenizer_match:'NOT_ASSERTED',
          serialization_status:'DOCLING_RESERIALIZED_NOT_EXACT_FLAT_TEXT_SPANS',source_mapping:'DOCLING_ITEM_REFERENCES',
          warnings:[...new Set([...(item.warnings??[]),...(!source_block_refs.length?['HYBRID_CHUNK_NO_FLAT_BLOCK_MAPPING']:[])])]};
        if(item.status==='GAP'||item.token_count>maxTokens)gaps.push(value);else{need(item.status==='PLANNED','HYBRID_CHUNK_WORKER_STATUS_INVALID');chunks.push(value);}
      }
      const ownChunks=chunks.filter(c=>c.doc_ref===doc.doc_id),ownGaps=gaps.filter(c=>c.doc_ref===doc.doc_id);
      need(Array.isArray(row.windows),'HYBRID_CHUNK_WORKER_WINDOWS_REQUIRED');
      const representedOrdinals=[];
      for(const item of row.windows){
        need(Number.isSafeInteger(item.ordinal)&&Array.isArray(item.member_ordinals)&&item.member_ordinals.length>0&&
          typeof item.contextualized_text==='string'&&item.text===item.contextualized_text&&Number.isSafeInteger(item.token_count)&&item.token_count<=maxTokens&&item.status==='PLANNED',
        'HYBRID_CHUNK_WORKER_WINDOW_INVALID');
        const children=item.member_ordinals.map(ordinal=>ownChunks.find(c=>c.ordinal===ordinal));
        need(children.every(Boolean)&&children.every((c,i)=>i===0||c.ordinal===children[i-1].ordinal+1)&&
          item.contextualized_text===children.map(c=>c.contextualized_text).join('\n\n'),'HYBRID_CHUNK_WINDOW_BINDING_INVALID');
        representedOrdinals.push(...item.member_ordinals);
        const window_ref='hybrid_window_'+hash({plan_ref,doc_ref:doc.doc_id,revision:doc.revision,...item});
        windows.push({...clone(item),window_ref,chunk_ref:window_ref,plan_ref,doc_ref:doc.doc_id,revision:doc.revision,title:doc.title??'',
          source_chunk_refs:children.map(c=>c.chunk_ref),source_block_refs:[...new Set(children.flatMap(c=>c.source_block_refs))],
          token_budget:maxTokens,tokenizer:tokenizerName,token_count_exact:true,model_tokenizer_match:'NOT_ASSERTED',
          serialization_status:'COMPOSED_DOCLING_CHUNKS_NOT_EXACT_FLAT_TEXT_SPANS',source_mapping:'DOCLING_ITEM_REFERENCES',
          warnings:[...new Set([...item.warnings,...children.flatMap(c=>c.warnings)])]});
      }
      need(hash(representedOrdinals)===hash(ownChunks.map(c=>c.ordinal)),'HYBRID_CHUNK_WINDOW_COVERAGE_INVALID');
      const rows=doc.blocks.map(block=>({doc_ref:doc.doc_id,revision:doc.revision,block_id:block.block_id,
        chunk_refs:ownChunks.filter(c=>c.source_block_refs.includes(block.block_id)).map(c=>c.chunk_ref),
        status:ownChunks.some(c=>c.source_block_refs.includes(block.block_id))?'REPRESENTED_BY_SOURCE_ITEMS':'UNREPRESENTED',
        coverage_precision:'ITEM_REFERENCE_ONLY_NOT_CHARACTER_OR_SEMANTIC_COVERAGE'}));
      coverage.push(...rows);
      documentSummary.push({doc_ref:doc.doc_id,revision:doc.revision,title:doc.title??'',source_document_id:documents[index].source_document_id,
        raw_document_sha256:documents[index].raw_sha256,chunks:ownChunks.length,windows:row.windows.length,gaps:ownGaps.length,source_blocks:rows.length,
        represented_blocks:rows.filter(r=>r.status==='REPRESENTED_BY_SOURCE_ITEMS').length,unrepresented_block_refs:rows.filter(r=>r.status==='UNREPRESENTED').map(r=>r.block_id)});
    }
    const warnings=[...(gaps.length?['HYBRID_CHUNK_OUTPUT_HAS_GAPS']:[]),...(coverage.some(r=>r.status==='UNREPRESENTED')?['HYBRID_CHUNK_SOURCE_ITEMS_UNREPRESENTED']:[]),
      ...(chunks.some(c=>c.warnings.includes('HYBRID_CHUNK_NO_FLAT_BLOCK_MAPPING'))?['HYBRID_CHUNK_NO_FLAT_BLOCK_MAPPING']:[])];
    const value={...binding,plan_ref,documents:documentSummary,chunks,windows,gaps,coverage,warnings,
      summary:{documents:documentSummary.length,chunks:chunks.length,windows:windows.length,gaps:gaps.length,source_blocks:coverage.length,represented_blocks:coverage.filter(r=>r.status==='REPRESENTED_BY_SOURCE_ITEMS').length},
      semantic_completeness_certified:false,model_calls:0,embedding_calls:0};
    const plan={...value,plan_sha256:hash(value)};
    if(outputDirectory){mkdirSync(outputDirectory,{recursive:true});const file=join(outputDirectory,'hybrid-chunk-plan.json');
      if(existsSync(file))need(hash(JSON.parse(readFileSync(file,'utf8')))===hash(plan),'HYBRID_CHUNK_PLAN_OUTPUT_CONFLICT');
      else{writeFileSync(file+'.tmp',JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(file+'.tmp',file);}}
    return plan;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
