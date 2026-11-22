"""Program owns dispatch, receiving and settlement. No provider SDK calls."""
import asyncio,json,time,threading
from datetime import datetime,timezone
import psycopg
from pathlib import Path
from types import SimpleNamespace
from ontoweave_cq.store import PGCQStore,require
from ontoweave_front_half.records import PGRecords
from .planner import build_plan,SKILL
from .repository import Reception
from . import POLICY_VERSION,V3_POLICY_VERSION,runtime_ref
from .run import ExtractionRun
from .native import ExtractionTransport
from .protocol import ExtractionTools,events
ROOT=Path(__file__).resolve().parents[2]
def write(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
async def execute(args, *, product_credential=None, product_simulation=None, product_dispatch_guard=None):
    started=time.perf_counter();started_at=datetime.now(timezone.utc).isoformat()
    output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=False)
    store=PGCQStore(json.loads(Path(args.pg_config).read_text()));policy=getattr(args,'reception_policy',POLICY_VERSION);receiver=Reception(store,policy=policy)
    if product_dispatch_guard is not None:
        store.product_dispatch_guard = product_dispatch_guard
    try:
        receiver.migrate()
        if args.command=='replay-source':
            from .replay import replay_source
            replay_source(store,receiver,args)
            store.close();store=PGCQStore(json.loads(Path(args.pg_config).read_text()));rereader=Reception(store,policy=policy);result=rereader.read_run(args.run_id)
            write(output/'readback.json',result);write(output/'plan.json',result['plan'])
            summary=dict(run_id=args.run_id,status=result['status'],execution_status=result['execution_status'],content_counts=result['content_counts'],content_warnings=result['content_warnings'],alignment_revision_ref=None,mode='REPLAY',producer_run_id=args.source_run_id,generation_requests=0,embedding_requests=0,new_connection_readback=True,wall_ms=(time.perf_counter()-started)*1000,started_at=started_at,ended_at=datetime.now(timezone.utc).isoformat(),semantic_quality='UNCHANGED_PRODUCER_CONTENT_UNASSESSED',output=str(output))
            write(output/'result.json',summary);write(output/'timings.json',dict(reception=receiver.reception_timings,candidate_pg_transactions=receiver.metrics,new_connection_pg_transactions=rereader.metrics));return summary
        if args.command in ('read','replay'):
            if args.command=='replay':
                from .replay import recover_run
                recovery = recover_run(receiver,args.run_id,args.reception_revision)
                write(output/'recovery.json',recovery)
            result=receiver.read_run(args.run_id);write(output/'readback.json',result);return dict(run_id=args.run_id,status=result['status'],generation_requests=0,embedding_requests=0,output=str(output),**({k:result[k] for k in ('execution_status','content_counts','content_warnings','business_result','alignment_revision_ref')} if policy==V3_POLICY_VERSION else {}))
        plan=build_plan(store,args.upstream_run_id,args.run_id,policy=policy,accept_partial=getattr(args,'accept_partial',False),real=args.command=='run' and args.mode=='REAL');write(output/'plan.json',plan)
        if args.command=='plan':return dict(run_id=args.run_id,status='PLANNED',tasks=len(plan['tasks']),generation_requests=0,embedding_requests=0,output=str(output))
        receiver.create(plan)
        config=json.loads(Path(args.public_config).read_text());require(config['models']['generation']['model']=='qwen3.8-flash','MODEL_CHANGED')
        credential=''
        if args.mode=='REAL':
            if product_credential is None:
                require(args.credential_file,'CREDENTIAL_FILE_REQUIRED');p=Path(args.credential_file);require(p.stat().st_mode&0o777==0o600,'CREDENTIAL_MODE_INVALID');credential=p.read_text().strip();require(credential,'CREDENTIAL_EMPTY')
            else:
                require(product_credential and product_simulation is None,'PRODUCT_EXTRACTION_CONFIG_INVALID')
                credential=product_credential
        simulation = None
        if args.mode == 'NATIVE_SIM':
            simulation = (product_simulation(plan['tasks']) if product_simulation else
                          json.loads(Path(args.simulation).read_text())['tasks'])
        if simulation is not None:require(len(simulation)==len(plan['tasks']),'SIMULATION_TASK_COUNT_MISMATCH')
        queue=list(enumerate(plan['tasks']));halt=threading.Event();results=[];start=time.perf_counter()
        async def worker():
            while queue and not halt.is_set():
                task_start=time.perf_counter();task_started_at=datetime.now(timezone.utc).isoformat()
                index,task=queue.pop(0);task_ref=task['task_ref'];repo=PGRecords(store,runtime_ref(policy,args.run_id,task_ref));repo.migrate();run=ExtractionRun(repo,repo.run_id);tools=ExtractionTools(repo,run,receiver,task);transport=None
                try:
                    receiver.mark_started(task_ref)
                    transport=ExtractionTransport(repo,run,config,credential,on_unknown=halt.set)
                    request=SimpleNamespace(agent_scope=task_ref,prompt=task['prompt'],skill_paths=(str(SKILL),),model='qwen3.8-flash',runtime_directory=str(output/'runtime'/task_ref),tools=tools,mode=args.mode,simulation=simulation[index] if simulation is not None else None)
                    result=await transport.invoke(request);state=tools.salvage(result)
                    if state['status']=='UNKNOWN_HOLD':halt.set()
                except Exception as e:
                    attempts=run.state()['attempts'];unknown=tools.database_unknown or any(a['outcome'] in ('UNKNOWN','RESERVED') for a in attempts) or bool(attempts) and isinstance(e,(psycopg.Error,OSError))
                    if unknown:halt.set()
                    state=receiver.settle_task(task_ref,final=True,force='UNKNOWN_HOLD' if unknown else 'FAILED');result=dict(error_code=getattr(e,'code',type(e).__name__))
                finally:
                    if transport:await asyncio.to_thread(transport.close)
                if state['status']=='UNKNOWN_HOLD':halt.set()
                usage=[]
                for row in repo.list_rows():
                    if row['kind']=='native_agent_response_v1':
                        try:
                            for event in events(row['payload'].get('body_utf8','').replace('\r\n','\n')):
                                if event.get('type') in ('response.completed','response.incomplete','response.failed'):
                                    usage.append(dict(request_ref=row['key'],provider_usage=event.get('response',{}).get('usage'),status='REPORTED' if event.get('response',{}).get('usage') is not None else 'NOT_PROVIDED'))
                        except (ValueError,KeyError):pass
                results.append(dict(full_provider_usage=usage,task_ref=task_ref,state=state,native=result,ledger=run.state(),rpc_timings=transport.timings if transport else [],pg_transactions=repo.metrics,started_at=task_started_at,ended_at=datetime.now(timezone.utc).isoformat(),wall_ms=(time.perf_counter()-task_start)*1000))
        await asyncio.gather(*(worker() for _ in range(args.concurrency)))
        for _,task in queue:receiver.settle_task(task['task_ref'],final=True,force='NOT_DISPATCHED_UNKNOWN')
        write(output/'task-results.json',results)
        # A new pool/connection verifies commit visibility, independently of writer pool.
        store.close();store=PGCQStore(json.loads(Path(args.pg_config).read_text()));read_receiver=Reception(store,policy=policy);readback=read_receiver.read_run(args.run_id);write(output/'readback.json',readback)
        attempts=[a for r in results for a in r['ledger']['attempts']]
        result=dict(run_id=args.run_id,status=readback['status'],mode=args.mode,tasks=len(plan['tasks']),candidates=len(readback['candidates']),generation_requests=len(attempts) if args.mode=='REAL' else 0,native_simulated_requests=len(attempts) if args.mode=='NATIVE_SIM' else 0,embedding_requests=0,actual_usage=[a.get('usage') for a in attempts],full_provider_usage=[u for r in results for u in r['full_provider_usage']],semantic_quality='UNASSESSED',publication='CANDIDATES_ONLY',wall_ms=(time.perf_counter()-started)*1000,started_at=started_at,ended_at=datetime.now(timezone.utc).isoformat(),execution_wall_ms=(time.perf_counter()-start)*1000,service_internal_timing='NOT_PROVIDED',output=str(output),new_connection_readback=True,halted_dispatch=halt.is_set())
        if policy==V3_POLICY_VERSION:result.update(execution_status=readback['execution_status'],content_counts=readback['content_counts'],content_warnings=readback['content_warnings'],alignment_revision_ref=None,alignment_status='NOT_ENABLED',reception_policy=policy,namespace=receiver.schema,business_result=readback['business_result'])
        write(output/'timings.json',dict(reception=receiver.reception_timings,candidate_pg_transactions=receiver.metrics,new_connection_pg_transactions=read_receiver.metrics,tasks=[{k:r[k] for k in ['task_ref','started_at','ended_at','wall_ms','pg_transactions','rpc_timings']} for r in results],service_internal_timing='NOT_PROVIDED'))
        write(output/'result.json',result);return result
    finally:store.close()
