"""One Python business entry; PG owns both live records and frozen artifacts."""
import asyncio,json,time,uuid
from contextlib import contextmanager
from datetime import datetime,timezone
from pathlib import Path
from ontoweave_cq.store import PGCQStore,read_bundle,same_projection
from ontoweave_cq5000.pipeline import CQPipeline
from ontoweave_cq5000.run import CQRun,KIND as RUN_KIND
from ontoweave_cq5000.dispatch import NativeCodexPort,verify_skill
from ontoweave_cq5000.pg_contract import prepare_archive
from ontoweave_cq5000.compat import sha,dump,clone
from ontoweave_cq_similarity.repository import SimilarityRepository
from ontoweave_cq_similarity.adapter import from_archive,load_plan_materials
from ontoweave_cq_similarity.core import digest,require,input_sha,normalize,build_plan
from ontoweave_cq_similarity.embedding import public_space,embed_once
from .baselines import CURRENT_BASELINE, verify_baseline
from .records import PGRecords,PGLedger
from .parse import ROOT,write,parse_files,chunk
from .native import NativeTransport

def utc():return datetime.now(timezone.utc).isoformat()
def verify_pins(baseline=CURRENT_BASELINE):
    return verify_baseline(baseline)

class Stages:
    def __init__(self,repo):self.repo=repo;self.rows=[]
    @contextmanager
    def __call__(self,name,inputs=None):
        row=dict(stage=name,started_at=utc(),status='RUNNING',input_counts=inputs or {},output_counts={},generation_requests=0,embedding_requests=0,usage=None,usage_status='NO_MODEL_REQUEST',warnings=[],skips=[],gaps=[],artifact_paths=[])
        start=time.perf_counter();self.rows.append(row);key=str(len(self.rows))+':'+name
        self.repo.put_record('stage',key,row)
        try:yield row;row['status']='COMPLETED'
        except Exception as e:
            row.update(status='FAILED_OR_UNKNOWN',error_code=getattr(e,'code',type(e).__name__))
            raise
        finally:
            row.update(ended_at=utc(),wall_ms=(time.perf_counter()-start)*1000)
            self.repo.put_record('stage',key,row)

class ReplayDispatcher:
    """Calls the same Python receiver; no native/model/Embedding request here."""
    def __init__(self,repo,run,proposals):self.repo,self.run,self.proposals=repo,run,proposals
    async def invoke(self,request):
        start=time.perf_counter();args=self.proposals[request.agent_scope]
        self.repo.put_record('replayed_proposal',request.agent_scope,dict(mode='REPLAY',raw_proposal=args))
        receipt=await request.tools.call_async('lightog_save_cq_list',args)
        require(receipt.get('ok') and request.tools.is_complete(),'REPLAY_SAVE_FAILED')
        with self.repo.transaction():
            state=self.run.state();ref='replay_'+uuid.uuid4().hex
            state['attempts'].append(dict(request_ref=ref,kind='REPLAY',role='CQ',agent_scope=request.agent_scope,outcome='RETURNED',usage=None,request_bytes=0,sent_at=None,ended_at=None))
            self.repo.put_record(RUN_KIND,self.run.run_id,state)
        self.repo.put_record('native_process',request.agent_scope,dict(mode='REPLAY',wall_ms=(time.perf_counter()-start)*1000))
        return dict(receipt=dict(status='SUCCEEDED',mode='REPLAY',actual_requests=0))

def archive_input(run_id,source,plan,result,artifacts):
    rows=[dict(name=role+'.json',role=role,bytes=dump(val).encode()) for role,val in [('snapshot',source),('plan',plan),('result',dict(run_id=run_id,execution_mode=result['execution_mode'],chunked=result['chunked']))]]
    # Old readbacks belong to their old cq_ref and are retained as baseline only.
    for a in artifacts:
        if a['role'] in ('snapshot','plan','result') or a['role'].startswith('readback:'):
            rows.append(dict(name='baseline-'+a['name'],role='baseline:'+a['role'],bytes=a['bytes']))
        else:rows.append(a)
    return dict(archive_id='front-half-'+run_id,artifacts=rows)

def similarity(store,repo,archive,config,credential,output,stage,allow_external):
    sr=SimilarityRepository(store);sr.migrate();space=public_space(config)
    data=from_archive(archive,archive['view']['snapshot']['library_id'],space);write(output/'similarity-input.json',data)
    vectors={};missing={};hits=0;receipts=[]
    with stage('embedding',dict(cqs=len(data['items']))) as row:
        for item in data['items']:
            ts=input_sha(item['question']);cached=sr.cache_get(data['library_ref'],space,ts)
            if cached is not None:vectors[item['cq_ref']]=cached;hits+=1
            else:missing.setdefault(ts,dict(text=normalize(item['question']),items=[]))['items'].append(item)
        entries=list(missing.values())
        require(not entries or allow_external,'REPLAY_CACHE_MISS_NO_EXTERNAL_CALL')
        for index in range(0,len(entries),20):
            batch=entries[index:index+20];key='embedding-'+str(index//20)
            vals,receipt=embed_once([b['text'] for b in batch],{**config,'api_key':credential},PGLedger(repo,key),output/(key+'-response.redacted.json'))
            receipts.append(receipt);new={item['cq_ref']:val for b,val in zip(batch,vals) for item in b['items']}
            subset=[item for b in batch for item in b['items']]
            sr.save_vectors({**data,'items':subset},new,receipt);vectors.update(new)
            repo.put_record('embedding_response',key,dict(receipt=receipt,vectors=new))
        row.update(embedding_requests=len(receipts),usage=[r['usage'] for r in receipts],usage_status='PROVIDED' if receipts and all(r['usage'] is not None for r in receipts) else 'NOT_PROVIDED' if receipts else 'NO_NEW_REQUEST',output_counts=dict(cache_hits=hits,cache_misses=len(entries),vectors=len(vectors)),cache_hits=hits,receipts=receipts)
    with stage('similarity_grouping',dict(cqs=len(data['items']))) as row:
        start=time.perf_counter();plan=build_plan(data,vectors);python_ms=(time.perf_counter()-start)*1000
        sr.save_vectors(data,vectors,dict(actual_requests=len(receipts),receipts=receipts))
        pairs,pgmetrics=sr.exact_pairs(data);exact={(p['left_cq_ref'],p['right_cq_ref']):p['cosine_similarity'] for p in pairs}
        delta=max((abs(p['cosine_similarity']-exact[(p['left_cq_ref'],p['right_cq_ref'])]) for p in plan['pairs']),default=0)
        require(delta<2e-6,'PG_COSINE_MISMATCH')
        plan.update(pg_pairs=pairs,pg_python_max_abs_delta=delta);del plan['plan_ref'];plan['plan_ref']='plan_'+digest(plan)
        sr.save_plan(plan);require(sr.read_plan(plan['plan_ref'])==plan,'PLAN_READBACK_MISMATCH')
        repo.put_record('similarity',repo.run_id,dict(plan_ref=plan['plan_ref'],input=data))
        write(output/'similarity-plan.json',plan)
        row.update(output_counts=dict(pairs=len(pairs),groups=len(plan['groups'])),python_cosine_grouping_ms=python_ms,pg_exact_metrics=pgmetrics,artifact_paths=[str(output/'similarity-plan.json')])
    return dict(plan_ref=plan['plan_ref'],cqs=len(data['items']),pairs=len(plan['pairs']),groups=len(plan['groups']),embedding_requests=len(receipts),cache_hits=hits)

def read_run(store,run_id):
    repo=PGRecords(store,run_id);rows=repo.list_rows();head=repo.get_record('front_half',run_id)
    require(head is not None,'RUN_UNKNOWN')
    result=dict(run_id=run_id,head=head,live_records=rows,generation_requests=0,embedding_requests=0,read_operation_only=True)
    if head.get('archive_id'):
        archive=store.read_archive(head['archive_id']);v=archive['view'];materials=[]
        if head.get('cq_archive_status')=='PARTIAL':
            chunked=v['result']['chunked']
            require(chunked['status']=='PARTIAL' and same_projection(chunked['execution_gaps'],head['cq_execution_gaps']),
                    'PARTIAL_CQ_ARCHIVE_GAPS_CHANGED')
        for item in v['merge']['cq_input']['items']:
            material=store.read_cq(head['archive_id'],item['cq_ref'])['material']
            expected={(r['doc_ref'],r['revision'],r['chunk_ref']) for r in [*item.get('ranges',[]),*item.get('fallback_ranges',[])]}
            require(all((u['doc_ref'],u['revision'],u['chunk_ref']) in expected for u in material['units']),'RANGE_SOURCE_CROSSED')
            materials.append(dict(cq_ref=item['cq_ref'],question=item['question'],material=material,range_source_verified=True))
        result.update(snapshot=v['snapshot'],plan=v['plan'],cq_result=v['result'],materials=materials,counts=store.counts(head['archive_id']))
        if head.get('plan_ref'):
            sr=SimilarityRepository(store);p=sr.read_plan(head['plan_ref']);s=repo.get_record('similarity',run_id)
            data=s['input'];group_materials=load_plan_materials(v,data,p['groups'])
            pairs,_=sr.exact_pairs(data);require(pairs==p['pg_pairs'],'PG_PAIR_READBACK_CHANGED')
            result.update(similarity=p,group_materials=group_materials)
    return result

async def execute(args):
    output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=False)
    started=time.perf_counter();begin=utc();pins=verify_pins(getattr(args,'baseline',CURRENT_BASELINE));public=json.loads(Path(args.public_config).read_text())
    require(public['models']['generation']['model']=='qwen3.8-flash','MODEL_CHANGED')
    require(public['models']['generation']['base_url'].rstrip('/')=='https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1','GENERATION_DESTINATION_CHANGED')
    credential=''
    if args.mode=='REAL':
        require(args.credential_file,'CREDENTIAL_FILE_REQUIRED');p=Path(args.credential_file);require(p.stat().st_mode&0o777==0o600,'CREDENTIAL_MODE_INVALID');credential=p.read_text().strip();require(credential,'CREDENTIAL_EMPTY')
    pg_config=json.loads(Path(args.pg_config).read_text());store=PGCQStore(pg_config);repo=PGRecords(store,args.run_id);repo.migrate();stages=Stages(repo);transport=None
    require(repo.get_record('front_half',args.run_id) is None,'RUN_ALREADY_EXISTS_USE_READ')
    head=dict(run_id=args.run_id,status='RUNNING',mode=args.mode,started_at=begin,workspace=args.workspace,upstream_pins=pins)
    repo.put_record('front_half',args.run_id,head)
    try:
        artifacts=[]
        if args.mode=='REPLAY' and not getattr(args,'files',None):
            with stages('frozen_replay_input',dict(bundles=1)) as row:
                bundle=read_bundle(args.replay_bundle);view=prepare_archive(bundle);source=view['snapshot'];plan=view['plan'];artifacts=bundle['artifacts']
                proposals={d['chunk_ref']:d['raw_proposal'] for d in view['drafts']}
                if args.replay_proposals:proposals=json.loads(Path(args.replay_proposals).read_text())
                repo.put_record('snapshot',args.run_id,source);repo.put_record('source_plan',args.run_id,plan)
                row['output_counts']=dict(documents=len(source['documents']),blocks=len(plan['windows']));row['skips']=['Parsing and chunking frozen inputs; not a new generation']
        else:
            if args.mode=='REPLAY':
                require(args.replay_proposals,'OFFLINE_PARSED_PROPOSALS_REQUIRED')
                proposals=json.loads(Path(args.replay_proposals).read_text())
            source,sources,artifacts=parse_files(args.files,args.workspace,args.run_id,output,args.parser_python,repo,stages)
            with stages('structure_chunking',dict(documents=len(source['documents']))) as row:
                plan=chunk(source,sources,output,args.parser_python);repo.put_record('source_plan',args.run_id,plan)
                row.update(output_counts=dict(blocks=len(plan['windows']),gaps=len(plan['gaps'])),gaps=plan['gaps'],warnings=plan['warnings'])
            if args.mode=='REPLAY':
                require(set(proposals)<={w['chunk_ref'] for w in plan['windows']},'OFFLINE_PROPOSAL_SOURCE_CHANGED')
        write(output/'snapshot.json',source);write(output/'plan.json',plan)
        run=CQRun(repo,args.run_id,dict(execution_policy='PROGRESS_GOVERNED_V1',cq_chunk_policy=dict(concurrency=args.concurrency),snapshot_id=source['snapshot_id']))
        if args.mode=='REPLAY':dispatcher=ReplayDispatcher(repo,run,proposals)
        else:
            transport=NativeTransport(repo,run,public,credential);dispatcher=NativeCodexPort(transport.invoke)
        pipe=CQPipeline(repo=repo,source=source,plan=plan,run=run,dispatcher=dispatcher,library_id=source['library_id'],run_id=args.run_id,concurrency=args.concurrency,runtime_directory=output/'native')
        with stages('block_cq',dict(blocks=len(plan['windows']))) as row:
            cq=await pipe.execute();state=pipe.snapshot();attempts=run.state()['attempts'];real=[a for a in attempts if a['kind']=='GENERATION']
            result=dict(execution_mode=args.mode,chunked=state)
            row.update(output_counts=dict(cqs=len(cq['cq_input']['items']),blocks=len(state['chunks'])),generation_requests=len(real),usage=[a.get('usage') for a in real],usage_status='PROVIDED' if real and all(a.get('usage') is not None for a in real) else 'NOT_PROVIDED' if real else 'NO_NEW_REQUEST',warnings=[w for c in state['chunks'] if c['status']=='RETURNED' for w in c['draft']['warnings']],gaps=state['execution_gaps'])
        with stages('archive_save',dict(cqs=len(cq['cq_input']['items']))) as row:
            bundle=archive_input(args.run_id,source,plan,result,artifacts);saved=store.save_archive(bundle)
            head['archive_id']=bundle['archive_id']
            if state['status']=='PARTIAL':
                head.update(cq_archive_status='PARTIAL',cq_execution_gaps=state['execution_gaps'],
                            new_dispatch_stopped=True,dispatch_status=run.state()['status'])
            repo.put_record('front_half',args.run_id,head);row['output_counts']=dict(archives=1);row['pg_metrics']=saved['timings']
            export=[]
            for i,a in enumerate(bundle['artifacts']):
                path=output/f'archive-{i:03d}.bin';path.write_bytes(a['bytes']);export.append(dict(name=a['name'],role=a['role'],path=path.name,sha256=sha(a['bytes'])))
            write(output/'archive-bundle.json',dict(archive_id=bundle['archive_id'],artifacts=export))
        archive=store.read_archive(head['archive_id'])
        partial=head.get('cq_archive_status')=='PARTIAL'
        try:
            sim=similarity(store,repo,archive,public['models']['embedding'],credential,output,stages,args.mode=='REAL' and not partial)
            head.update(sim)
        except Exception as exc:
            if not partial or not isinstance(exc,ValueError) or str(exc)!='REPLAY_CACHE_MISS_NO_EXTERNAL_CALL':
                raise
            head['similarity_gap']=dict(code=str(exc))
        repo.put_record('front_half',args.run_id,head)
        with stages('reopen_pg_readback',dict(archives=1)) as row:
            reopened=PGCQStore(pg_config)
            try:readback=read_run(reopened,args.run_id)
            finally:reopened.close()
            write(output/'readback.json',readback);row.update(output_counts=dict(blocks=len(readback['plan']['windows']),cqs=len(readback['materials']),groups=len(readback.get('similarity',{}).get('groups',[]))),artifact_paths=[str(output/'readback.json')])
        head['status']='PARTIAL' if partial else 'COMPLETED'
        if not partial:
            with repo.transaction():
                final_run=run.state();final_run.update(status='COMPLETED',ended_at=int(time.time()*1000));repo.put_record(RUN_KIND,args.run_id,final_run)
    except Exception as e:
        ledger=repo.get_record(RUN_KIND,args.run_id)
        head.update(status='UNKNOWN_HOLD' if ledger and ledger['status']=='UNKNOWN_HOLD' else 'FAILED',error_code=getattr(e,'code',str(e) if isinstance(e,ValueError) else type(e).__name__),new_dispatch_stopped=True)
        # No retry, fallback, replacement run or model switch. Live PG partials remain.
    finally:
        if transport:
            transport.close();write(output/'rpc-timings.json',transport.timings)
        ledger=repo.get_record(RUN_KIND,args.run_id);attempts=ledger['attempts'] if ledger else []
        real=[a for a in attempts if a['kind']=='GENERATION']
        embeddings=[r['payload'] for r in repo.list_rows() if r['kind']=='embedding_request']
        head['embedding_requests']=sum(r.get('actual_requests',0) for r in embeddings)
        head['embedding_receipts']=embeddings
        for stage in stages.rows:
            if stage['stage']=='block_cq':
                stage.update(generation_requests=len(real),usage=[a.get('usage') for a in real],usage_status='PROVIDED' if real and all(a.get('usage') is not None for a in real) else 'NOT_PROVIDED' if real else 'NO_NEW_REQUEST')
            if stage['stage']=='embedding':stage['embedding_requests']=head['embedding_requests']
        per_block=[dict(scope=r['key'],**r['payload']) for r in repo.list_rows() if r['kind']=='native_process']
        wires={r['key']:r['payload'] for r in repo.list_rows() if r['kind']=='native_agent_wire_v1'}
        responses={r['key']:r['payload'] for r in repo.list_rows() if r['kind']=='native_agent_response_v1'}
        request_times=[dict(request_ref=a['request_ref'],scope=a['agent_scope'],outcome=a['outcome'],usage=a.get('usage'),usage_status='PROVIDED' if a.get('usage') is not None else 'NOT_PROVIDED',started_at=wires.get(a['request_ref'],{}).get('started_at'),ended_at=responses.get(a['request_ref'],{}).get('ended_at'),provider_stream_wall_ms=responses[a['request_ref']]['ended_at']-wires[a['request_ref']]['started_at'] if a['request_ref'] in responses and a['request_ref'] in wires else None) for a in real]
        head['generation_request_details']=request_times
        head.update(ended_at=utc(),wall_ms=(time.perf_counter()-started)*1000,generation_requests=len(real),generation_usage=[a.get('usage') for a in real],generation_usage_status='PROVIDED' if real and all(a.get('usage') is not None for a in real) else 'NOT_PROVIDED' if real else 'NO_NEW_REQUEST',stages=stages.rows,block_wall_times=per_block,parallel_block_wall_sum_ms=sum(b['wall_ms'] for b in per_block),db_live_transaction_ms=sum(m.get('transaction_ms',0) for m in repo.metrics),observability='Provider request wall includes network/stream and record operations; internal inference duration unavailable. cl100k material tokens are not Qwen billing tokens.',output=str(output))
        repo.put_record('front_half',args.run_id,head);write(output/'result.json',head);write(output/'stages.json',stages.rows)
        write(output/'live-records.json',repo.list_rows());store.close()
    return head
