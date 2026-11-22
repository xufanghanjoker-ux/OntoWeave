"""File orchestration only; parsing and structural splitting reuse frozen workers."""
import json,os,subprocess,uuid
from pathlib import Path
from ontoweave_cq5000.compat import DEFAULT_HASHER as H,sha,clone
from ontoweave_cq_similarity.core import require
ROOT=Path(__file__).resolve().parents[2]
POLICY=dict(engine='DoclingHybridChunker',max_tokens=5000,tokenizer='cl100k_base',token_count_exact=True,model_tokenizer_match='NOT_ASSERTED',merge_peers=True,repeat_table_header=True,always_emit_headings=True,structure_strategy='DOCLING_ORDERED_UNITS_AND_CONTEXT_V2',split_strategy='HYBRID_CHUNKER_SEGMENT_WITH_FROZEN_CELL_COORDINATES',budget_scope='SERIALIZED_MATERIAL_WITH_UNIT_LABELS',range_contract='CQ_UNIT_RANGES_V1',source_mapping='DOCLING_ITEM_REFERENCES',window_composition='ONE_PROCESSING_BLOCK_NO_SECOND_PACKING_V2')
def write(path,value):
    Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def env():
    return dict(PATH=os.environ.get('PATH','/usr/bin:/bin'),LANG='en_US.UTF-8',TMPDIR=os.environ.get('TMPDIR','/tmp'),HF_HOME=str(ROOT/'.ontoweave/docling-models'),HF_HUB_DISABLE_TELEMETRY='1',HF_HUB_OFFLINE='1',OMP_NUM_THREADS='4',TIKTOKEN_CACHE_DIR=str(ROOT/'.ontoweave/docling-models/tiktoken'),PYTHONDONTWRITEBYTECODE='1')
def worker(name,args,python):
    proc=subprocess.run([str(python),str(ROOT/'web'/name),*map(str,args)],cwd=ROOT,env=env(),capture_output=True,timeout=180)
    require(proc.returncode==0,'FRONT_HALF_'+name.upper().replace('.','_')+'_FAILED')

def parse_files(files,library,run_id,output,python,repo,stage,*,document_ids=None):
    docs=[];sources=[];artifacts=[]; manifest=[]
    require(len(files)==len(set(map(lambda p:str(Path(p).resolve()),files))) and files,'INPUT_FILES_INVALID')
    if document_ids is not None:
        require(len(document_ids)==len(files) and len(set(document_ids))==len(files) and all(document_ids),
                'PRODUCT_DOCUMENT_IDS_INVALID')
    for i,source in enumerate(files):
        source=Path(source).resolve(); original=source.read_bytes(); revision=sha(original)
        doc_id=document_ids[i] if document_ids is not None else 'doc_'+sha(str(source))[:32]; raw_path=output/f'docling-{i}.json'
        with stage('parse:'+source.name,dict(files=1,bytes=len(original))) as row:
            frozen=output/('input-'+str(i)+source.suffix);frozen.write_bytes(original)
            worker('docling_worker.py',[frozen,raw_path],python)
            require(sha(frozen.read_bytes())==revision,'PARSER_INPUT_CHANGED')
            raw=json.loads(raw_path.read_text()); blocks=raw['blocks']; content='\n\n'.join(b['text'] for b in blocks if b['text'].strip())
            require(content,'EMPTY_PARSED_CONTENT')
            doc=dict(doc_id=doc_id,revision=revision,title=source.stem,content=content,blocks=blocks,parser=dict(name='docling',version=raw['parser_version'],original_sha256=revision,parsed_sha256=sha(content)))
            docs.append(doc);sources.append(dict(doc_ref=doc_id,revision=revision,title=source.stem,raw_path=str(raw_path),raw_sha256=sha(raw_path.read_bytes()),source_document_id=doc_id))
            artifacts.extend([dict(name=f'original-{i}'+source.suffix,role='original:'+doc_id,bytes=original),dict(name=raw_path.name,role='docling:'+doc_id,bytes=raw_path.read_bytes())])
            manifest.append(dict(path=str(source),doc_ref=doc_id,revision=revision,bytes=len(original)))
            repo.put_record('source',doc_id,dict(document=doc,original_hex=original.hex(),docling=raw,source_path=str(source)))
            row['output_counts']=dict(documents=1,structural_items=len(blocks));row['warnings']=raw.get('warnings',[])
    snapshot=dict(snapshot_id='snapshot_'+H.digest(dict(library=library,documents=docs)),library_id=library,documents=docs)
    snapshot['fingerprint']=H.digest(snapshot)
    repo.put_record('snapshot',run_id,snapshot);write(output/'snapshot.json',snapshot);write(output/'sources.json',manifest)
    return snapshot,sources,artifacts

def chunk(snapshot,sources,output,python):
    request=output/'chunk-request.json'; response=output/'chunk-response.json'
    write(request,dict(max_tokens=5000,tokenizer_name='cl100k_base',structure_blocks=True,documents=sources))
    worker('docling_hybrid_chunk_worker.py',[request,response],python)
    result=json.loads(response.read_text());policy={**POLICY,'versions':result['versions'],'tokenizer_data_sha256':result['tokenizer_data_sha256'],'implementation_sha256':sha(b''.join((ROOT/p).read_bytes() for p in ['web/docling_hybrid_chunk_worker.py','web/docling_structure_blocks_v2.py']))}
    binding=dict(version='docling-structure-blocks/2',source_snapshot_ref=snapshot['snapshot_id'],source_fingerprint=snapshot['fingerprint'],policy=policy,sources=[{k:v for k,v in s.items() if k!='raw_path'} for s in sources])
    plan_ref='hybrid_plan_'+H.digest(binding);chunks=[];windows=[];gaps=[];coverage=[];summaries=[]
    for doc,row in zip(snapshot['documents'],result['documents']):
        require(row['doc_ref']==doc['doc_id'] and row['revision']==doc['revision'],'CHUNK_SOURCE_MISMATCH')
        block_ids={b['block_id'] for b in doc['blocks']};own=[]
        for item in row['chunks']:
            ref='hybrid_chunk_'+H.digest(dict(plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],**item))
            units=[{**u,'unit_ref':'cq_unit_'+H.digest(dict(plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],chunk_ref=ref,**{k:u[k] for k in ('label','text','context','fragment')}))} for u in item.get('units',[])]
            refs=list(dict.fromkeys(r for s in item['source_items'] for r in [s['self_ref'],*s.get('parent_refs',[])] if r in block_ids))
            val=dict(chunk_ref=ref,plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],title=doc['title'],**{**clone(item),'units':units},source_block_refs=refs,token_budget=5000,tokenizer='cl100k_base',token_count_exact=True,model_tokenizer_match='NOT_ASSERTED',serialization_status='DOCLING_RESERIALIZED_NOT_EXACT_FLAT_TEXT_SPANS',source_mapping='DOCLING_ITEM_REFERENCES')
            if item['status']=='GAP':gaps.append(val)
            else:
                require(0<item['token_count']<=5000,'MATERIAL_BUDGET_EXCEEDED');chunks.append(val);own.append(val)
        for item in row['windows']:
            children=[next(c for c in own if c['ordinal']==n) for n in item['member_ordinals']]
            require(len(children)==1,'STRUCTURE_ONE_BLOCK_EXPECTED')
            ref='hybrid_window_'+H.digest(dict(plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],**item))
            windows.append(dict(**{k:v for k,v in clone(item).items() if k!='units'},window_ref=ref,chunk_ref=ref,plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],title=doc['title'],source_chunk_refs=[c['chunk_ref'] for c in children],source_block_refs=children[0]['source_block_refs'],units=children[0]['units'],manifest_ref='cq_manifest_'+H.digest(dict(plan_ref=plan_ref,doc_ref=doc['doc_id'],revision=doc['revision'],window_ref=ref,units=children[0]['units']))))
        for b in doc['blocks']:
            refs=[c['chunk_ref'] for c in own if b['block_id'] in c['source_block_refs']]
            coverage.append(dict(doc_ref=doc['doc_id'],revision=doc['revision'],block_id=b['block_id'],chunk_refs=refs,status='REPRESENTED_BY_SOURCE_ITEMS' if refs else 'UNREPRESENTED'))
        summaries.append(dict(doc_ref=doc['doc_id'],revision=doc['revision'],chunks=len(own),windows=len(row['windows']),gaps=sum(g['doc_ref']==doc['doc_id'] for g in gaps)))
    plan=dict(**binding,plan_ref=plan_ref,documents=summaries,chunks=chunks,windows=windows,gaps=gaps,coverage=coverage,warnings=['HYBRID_CHUNK_OUTPUT_HAS_GAPS'] if gaps else [],model_calls=0,embedding_calls=0,semantic_completeness_certified=False)
    plan['plan_sha256']=H.digest(plan);return plan
