"""One candidate writer. Durable raw archive precedes short receiving batches."""
import json,time
from datetime import datetime,timezone
from contextlib import contextmanager
from pathlib import Path
from psycopg.types.json import Jsonb
from psycopg import DataError,IntegrityError
from ontoweave_cq.store import sha,require
from ontoweave_cq_similarity.core import digest
from . import POLICY_VERSION,V3_POLICY_VERSION
from .parser import parse
ROOT=Path(__file__).resolve().parents[2]
TERMINAL={'COMPLETED','PARTIAL','FAILED','NO_CANDIDATES','UNKNOWN_HOLD'}

def open_content_summary(receipts):
    counts={k:sum(r.get('content_counts',{}).get(k,0) for r in receipts) for k in ('structured','open_only','skipped')}
    has_fact=any(r['candidate_refs'] for r in receipts)
    has_entity=any(i.get('mention_ref') for r in receipts for i in r['items'] if i['record']['kind']=='实体')
    legal=any(r['legal_no_knowledge'] for r in receipts)
    return dict(content_counts=counts,content_warnings=[w for r in receipts for w in r.get('content_warnings',[])],alignment_revision_ref=None,business_result='CANDIDATES' if has_fact else 'ENTITIES_ONLY_NO_FACT_CANDIDATES' if has_entity else 'NO_CANDIDATES' if legal else 'NO_USABLE_DELIVERY')
class Reception:
    def __init__(self,store,policy=POLICY_VERSION):
        require(policy in (POLICY_VERSION,V3_POLICY_VERSION),'UNKNOWN_RECEPTION_POLICY')
        self.store=store;self.policy=policy;self.v3=policy==V3_POLICY_VERSION;self.schema='extraction_v3' if self.v3 else 'extraction_v2';self.metrics=[];self.reception_timings=[]
    @contextmanager
    def transaction(self,readonly=False):
        start=time.perf_counter();metric={};outcome='CONFIRMED'
        try:
            with self.store.transaction(readonly=readonly) as (q,m):
                metric=m
                def scoped(sql,args=None):return q(sql.replace('extraction_v2',self.schema),args)
                yield scoped,m
        except Exception:
            outcome='FAILED_OR_UNKNOWN';raise
        finally:self.metrics.append(dict(**metric,wall_ms=(time.perf_counter()-start)*1000,outcome=outcome,readonly=readonly))
    def migrate(self):
        version=3 if self.v3 else 2
        raw=(ROOT/('migrations/005-extraction-v3.sql' if self.v3 else 'migrations/004-extraction-v2.sql')).read_bytes();pin=sha(raw)
        with self.transaction() as (q,_):
            q("SELECT pg_advisory_xact_lock(hashtext('extraction-v2-schema'))")
            exists=q("SELECT to_regclass('extraction_v2.schema_version') AS t").fetchone()['t']
            if exists:require(q('SELECT sha256 FROM extraction_v2.schema_version WHERE version=%s',[version]).fetchone()['sha256']==pin,'EXTRACTION_MIGRATION_CHANGED')
            else:q(raw.decode());q('INSERT INTO extraction_v2.schema_version VALUES(%s,%s)',[version,pin])
    def create(self,plan,*,reuse=False):
        if self.v3:plan={**plan,'reception_policy':self.policy,'namespace':self.schema}
        require(plan.get('reception_policy',POLICY_VERSION)==self.policy,'RUN_POLICY_MISMATCH')
        with self.transaction() as (q,_):
            sql='INSERT INTO extraction_v2.runs(run_id,manifest,sha256) VALUES(%s,%s,%s)'
            if reuse:sql+=' ON CONFLICT DO NOTHING'
            inserted=q(sql+' RETURNING run_id',[plan['run_id'],Jsonb(plan),digest(plan)]).fetchone()
            if not inserted:
                old=q('SELECT manifest,sha256 FROM extraction_v2.runs WHERE run_id=%s',[plan['run_id']]).fetchone()
                require(old and old['sha256']==digest(plan) and old['sha256']==digest(old['manifest']),
                        'REPLAY_RUN_BINDING_CHANGED')
                return
            for task in plan['tasks']:q('INSERT INTO extraction_v2.tasks(task_ref,run_id,manifest) VALUES(%s,%s,%s)',[task['task_ref'],plan['run_id'],Jsonb(task)])
    def mark_started(self,ref):
        with self.transaction() as (q,_):
            changed=q("UPDATE extraction_v2.tasks SET status='RUNNING' WHERE task_ref=%s AND status='PREPARED' AND NOT frozen RETURNING task_ref",[ref]).fetchone()
            require(changed,'EXTRACTION_TASK_ALREADY_DISPATCHED')
    def task(self,ref):
        with self.transaction(readonly=True) as (q,_):return q('SELECT * FROM extraction_v2.tasks WHERE task_ref=%s',[ref]).fetchone()
    def archive(self,task_ref,identity,raw,delivery):
        response_ref='response_'+digest(dict(task_ref=task_ref,identity=identity))
        with self.transaction() as (q,_):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))',[task_ref])
            task=q('SELECT * FROM extraction_v2.tasks WHERE task_ref=%s FOR UPDATE',[task_ref]).fetchone();require(task,'TASK_UNKNOWN')
            old=q('SELECT * FROM extraction_v2.responses WHERE response_ref=%s',[response_ref]).fetchone()
            if old:
                require(old['sha256']==sha(raw) and old['identity']==identity and old['delivery']==delivery,'RESPONSE_IMMUTABLE_CONFLICT');return response_ref
            q('INSERT INTO extraction_v2.responses(response_ref,task_ref,identity,raw,sha256,delivery,late) VALUES(%s,%s,%s,%s,%s,%s,%s)',[response_ref,task_ref,Jsonb(identity),raw,sha(raw),Jsonb(delivery),task['frozen']])
        return response_ref
    def receive(self,response_ref,policy=None):
        policy=policy or self.policy
        start=time.perf_counter();begin=datetime.now(timezone.utc).isoformat()
        try:return self._receive(response_ref,policy)
        finally:self.reception_timings.append(dict(response_ref=response_ref,started_at=begin,ended_at=datetime.now(timezone.utc).isoformat(),wall_ms=(time.perf_counter()-start)*1000))
    def _receive(self,response_ref,policy):
        with self.transaction(readonly=True) as (q,_):
            row=q('SELECT * FROM extraction_v2.responses WHERE response_ref=%s',[response_ref]).fetchone();require(row,'RESPONSE_UNKNOWN')
            old=q('SELECT payload FROM extraction_v2.receipts WHERE response_ref=%s AND policy=%s',[response_ref,policy]).fetchone()
            if old:return old['payload']
        raw_auth=row['sha256']==sha(row['raw'])
        if not self.v3:require(raw_auth,'RAW_SHA_CHANGED')
        task=self.task(row['task_ref']);manifest=task['manifest'];d=row['delivery'];outcome=d['outcome'];source_auth=True
        if self.v3:
            with self.transaction(readonly=True) as (q,_):binding=q('SELECT manifest,sha256 FROM extraction_v2.runs WHERE run_id=%s',[task['run_id']]).fetchone()
            source_auth=bool(binding and digest(binding['manifest'])==binding['sha256'] and any(t==manifest for t in binding['manifest']['tasks']))
            source_auth=source_auth and all(not u.get('text_sha256') or 'text' in u and sha(u['text'])==u['text_sha256'] for u in manifest.get('sources',{}).values())
        trusted=outcome=='RETURNED' and d.get('transport_complete') and d.get('native_completion') and d.get('identity_verified')
        known_terminal=outcome=='KNOWN_INCOMPLETE' and all(d.get(k) for k in ['explicit_terminal','identity_verified','raw_authenticated'])
        known=known_terminal and d.get('certified_complete_message')
        auth_failed=not raw_auth or not source_auth or (self.v3 and outcome=='RETURNED' and not d.get('identity_verified'))
        adopted=(trusted or known) and not row['late'] and not auth_failed;raw=bytes(row['raw'])
        parsed=parse(raw,policy=self.policy) if adopted else dict(records=[],end_declaration='MISSING',legal_no_knowledge=False,diagnostics=[],repairs=[])
        item_results=[];gaps=list(parsed['diagnostics']);warnings=[]
        # Independent batches commit prefixes. A crash before receipt is replayable by item keys.
        for at in range(0,len(parsed['records']),20):
            with self.transaction() as (q,_):
                q('SELECT pg_advisory_xact_lock(hashtext(%s))',[row['task_ref']])
                current=q('SELECT frozen FROM extraction_v2.tasks WHERE task_ref=%s FOR UPDATE',[row['task_ref']]).fetchone()
                if current['frozen'] and policy==self.policy:
                    settled=q('SELECT payload FROM extraction_v2.receipts WHERE response_ref=%s AND policy=%s',
                              [response_ref,policy]).fetchone()
                    require(settled,'TASK_SEALED_DURING_RECEIVE')
                    return settled['payload']
                for rec in parsed['records'][at:at+20]:
                    item_ref='item_'+digest([row['task_ref'],response_ref,policy,rec['start'],rec['end']]);q('SAVEPOINT extraction_item')
                    try:
                        existing=q('SELECT payload FROM extraction_v2.items WHERE item_ref=%s',[item_ref]).fetchone()
                        if existing:item_results.append(existing['payload']);q('RELEASE SAVEPOINT extraction_item');continue
                        result=self._save_record(q,task,rec,item_ref,policy)
                        q('INSERT INTO extraction_v2.items VALUES(%s,%s,%s,%s,%s,%s,%s)',[item_ref,response_ref,policy,rec['start'],rec['end'],Jsonb(result),result.get('candidate_ref')])
                        q('RELEASE SAVEPOINT extraction_item');item_results.append(result)
                    except (DataError,IntegrityError) as error:
                        q('ROLLBACK TO SAVEPOINT extraction_item');q('RELEASE SAVEPOINT extraction_item')
                        result=dict(item_ref=item_ref,record=rec,disposition='SKIPPED',blocking=True,error=type(error).__name__)
                        q('INSERT INTO extraction_v2.items VALUES(%s,%s,%s,%s,%s,%s,NULL)',[item_ref,response_ref,policy,rec['start'],rec['end'],Jsonb(result)]);item_results.append(result)
        for item in item_results:
            if item['blocking']:gaps.append(dict(item_ref=item['item_ref'],diagnostics=item['record']['diagnostics']))
            warnings.extend(item.get('warnings',[]))
        counts={name:sum(i['disposition']==name for i in item_results if i['record']['kind']=='事实') for name in ['STRUCTURED','PRESERVED','SKIPPED']}
        status='UNKNOWN_HOLD' if outcome=='UNKNOWN' or outcome=='KNOWN_INCOMPLETE' and not known_terminal else 'PARTIAL' if known_terminal and not adopted else 'FAILED' if not adopted else 'PARTIAL' if gaps or known else 'SAVED'
        receipt=dict(receipt_ref='receipt_'+digest([response_ref,policy]),task_ref=row['task_ref'],response_ref=response_ref,policy=policy,delivery_status=outcome,end_declaration=parsed['end_declaration'],reception_status=status,legal_no_knowledge=parsed['legal_no_knowledge'],items=item_results,counts=counts,gaps=gaps,warnings=warnings,repairs=parsed['repairs'],late=row['late'],raw_sha256=row['sha256'],candidate_refs=sorted({i['candidate_ref'] for i in item_results if i.get('candidate_ref')}))
        if self.v3:
            if auth_failed:gaps.append(dict(code='SOURCE_OR_RAW_AUTHENTICATION_FAILED'))
            # All classifications, including residual diagnostics, are durably handled.
            receipt.update(execution_status='UNKNOWN_HOLD' if status=='UNKNOWN_HOLD' else 'FAILED' if not adopted and not known_terminal else 'PARTIAL' if known_terminal else 'COMPLETED',content_counts=dict(structured=counts['STRUCTURED'],open_only=counts['PRESERVED'],skipped=counts['SKIPPED']),content_warnings=warnings+[d for i in item_results for d in i['record']['diagnostics']]+parsed['diagnostics'],alignment_revision_ref=None)
            if trusted and not row['late'] and not auth_failed:receipt['reception_status']='SAVED'
            if auth_failed:receipt.update(execution_status='FAILED',reception_status='FAILED')
        if row['late']:receipt['reception_status']='ARCHIVED_LATE'
        with self.transaction() as (q,_):
            q('INSERT INTO extraction_v2.receipts VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',[receipt['receipt_ref'],response_ref,policy,Jsonb(receipt)])
        return self.read_reception(receipt['receipt_ref'])
    def _save_record(self,q,task,rec,item_ref,policy):
        sources=[];warnings=[];mapping=task['manifest']['sources']
        for ref in rec['sources']:
            if ref in mapping:sources.append({**{k:v for k,v in mapping[ref].items() if k!='text'},'unit_label':mapping[ref].get('label'),'label':ref,'precision':'UNIT'})
            else:warnings.append('UNKNOWN_SOURCE:'+ref)
        if not sources:sources=[dict(precision='TASK_ONLY',task_ref=task['task_ref'])];warnings.append('TASK_ONLY_PROVENANCE')
        scope=[{k:s[k] for k in ('doc_ref','revision','unit_ref') if k in s} for s in sources]
        def mention(name,declaration=None):
            ref='mention_'+digest([task['task_ref'],scope,name])
            q('INSERT INTO extraction_v2.mentions(mention_ref,task_ref,name,scope) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',[ref,task['task_ref'],name,Jsonb(scope)])
            if declaration:q('UPDATE extraction_v2.mentions SET declarations=CASE WHEN declarations @> %s::jsonb THEN declarations ELSE declarations || %s::jsonb END WHERE mention_ref=%s',[Jsonb([declaration]),Jsonb([declaration]),ref])
            return ref
        result=dict(item_ref=item_ref,record=rec,blocking=rec['blocking'],warnings=warnings,disposition='ENTITY' if rec['kind']=='实体' else 'NO_KNOWLEDGE' if rec['kind']=='无相关知识' else rec['disposition'])
        if rec['kind']=='实体' and rec.get('name'):result['mention_ref']=mention(rec['name'],{k:rec.get(k) for k in ['category','category_raw','type','aliases']})
        if rec['kind']=='事实' and result['disposition']!='SKIPPED':
            payload={k:rec.get(k) for k in ['subject','predicate','value_kind','value','value_raw','unit','qualifiers','times','extras']}
            if self.v3:
                payload.update(statement_kind='OPEN_STATEMENT',relation_phrase=rec.get('predicate'),extensions=rec.get('extensions',[]),structure_usable=rec.get('structure_usable',False),content_warnings=rec.get('content_warnings',[]),alignment_revision_ref=None,identity_alignment_revision_ref=None,ontology_alignment_revision_ref=None,time_alignment_revision_ref=None,alignment_status='NOT_ENABLED')
            payload['source_scope']=sources;payload['normalization']='SOURCE_LOCAL_UNRESOLVED';payload['policy_version']=policy
            if result['disposition']=='PRESERVED':payload['original_record']=rec['raw_utf8']
            payload['subject_mention_ref']=mention(rec['subject']) if rec.get('subject') else None
            if rec.get('value_kind')=='客体' and rec.get('value_raw'):payload['object_mention_ref']=mention(rec['value_raw'])
            for qualifier in rec['qualifiers']:
                if qualifier.get('value_kind')=='限定实体' and qualifier.get('value'):qualifier['mention_ref']=mention(qualifier['value'])
            payload['qualifiers']=rec['qualifiers']
            ref='candidate_'+digest([task['task_ref'],payload]);result['candidate_ref']=ref
            q('INSERT INTO extraction_v2.candidates VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',[ref,task['task_ref'],result['disposition'],Jsonb(payload)])
            for source in sources:q('INSERT INTO extraction_v2.candidate_sources VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',[ref,digest(source),Jsonb(source)])
        return result
    def read_reception(self,ref):
        with self.transaction(readonly=True) as (q,_):
            row=q('SELECT payload FROM extraction_v2.receipts WHERE receipt_ref=%s',[ref]).fetchone();require(row,'RECEIPT_UNKNOWN');return row['payload']
    def settle_task(self,ref,final=False,force=None):
        if self.v3:return self._settle_open_task(ref,final,force)
        with self.transaction() as (q,_):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))',[ref]);task=q('SELECT * FROM extraction_v2.tasks WHERE task_ref=%s FOR UPDATE',[ref]).fetchone();require(task,'TASK_UNKNOWN')
            if task['frozen']:return dict(task_ref=ref,status=task['status'],frozen=True,continue_eligible=False)
            rows=q('SELECT r.payload,s.identity,s.delivery FROM extraction_v2.receipts r JOIN extraction_v2.responses s USING(response_ref) WHERE s.task_ref=%s AND NOT s.late AND r.policy=%s ORDER BY s.created_at,s.response_ref',[ref,POLICY_VERSION]).fetchall();rs=[r['payload'] for r in rows]
            pending=q('SELECT count(*) AS n FROM extraction_v2.responses s WHERE task_ref=%s AND NOT late AND NOT EXISTS(SELECT 1 FROM extraction_v2.receipts r WHERE r.response_ref=s.response_ref AND r.policy=%s)',[ref,POLICY_VERSION]).fetchone()['n']
            has_facts=any(r['candidate_refs'] for r in rs);has_entity=any(any(i['disposition']=='ENTITY' for i in r['items']) for r in rs)
            unknown=pending or any(r['reception_status']=='UNKNOWN_HOLD' for r in rs)
            gaps=any(r['gaps'] or r['reception_status'] in ('PARTIAL','FAILED') for r in rs)
            ended=bool(rs) and rs[-1]['end_declaration']=='EXPLICIT';legal=any(r['legal_no_knowledge'] for r in rs)
            turns={(r['delivery'].get('native_completion',{}).get('thread_id',r['identity'].get('thread_id')),r['delivery'].get('native_completion',{}).get('turn_id',r['identity'].get('turn_id'))) for r in rows if r['payload']['delivery_status']=='RETURNED'}
            eligible=bool(rs) and rs[-1]['delivery_status']=='RETURNED' and rs[-1]['end_declaration']=='MISSING' and len(turns)==1 and not unknown and not force
            if unknown:status='UNKNOWN_HOLD'
            elif force:status=force
            elif ended and not gaps and has_facts:status='COMPLETED'
            elif ended and not gaps and legal:status='NO_CANDIDATES'
            elif eligible and not final:status='AWAIT_CONTINUATION'
            else:status='PARTIAL' if has_facts or has_entity else 'FAILED'
            freeze=final or status in ('COMPLETED','NO_CANDIDATES','UNKNOWN_HOLD') or ended
            q('UPDATE extraction_v2.tasks SET status=%s,frozen=%s WHERE task_ref=%s',[status,freeze,ref])
            return dict(task_ref=ref,status=status,frozen=freeze,continue_eligible=eligible and not freeze,receipt_refs=[r['receipt_ref'] for r in rs],candidates=len({c for r in rs for c in r['candidate_refs']}))

    def _settle_open_task(self,ref,final,force):
        with self.transaction() as (q,_):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))',[ref])
            task=q('SELECT * FROM extraction_v2.tasks WHERE task_ref=%s FOR UPDATE',[ref]).fetchone();require(task,'TASK_UNKNOWN')
            rows=q('SELECT r.payload,s.identity,s.delivery FROM extraction_v2.receipts r JOIN extraction_v2.responses s USING(response_ref) WHERE s.task_ref=%s AND NOT s.late AND r.policy=%s ORDER BY s.created_at,s.response_ref',[ref,self.policy]).fetchall();rs=[r['payload'] for r in rows]
            counts={k:sum(r.get('content_counts',{}).get(k,0) for r in rs) for k in ('structured','open_only','skipped')}
            extra=open_content_summary(rs)
            if task['frozen']:return dict(**extra,task_ref=ref,status=task['status'],execution_status=task['status'],frozen=True,continue_eligible=False)
            pending=q('SELECT count(*) AS n FROM extraction_v2.responses s WHERE task_ref=%s AND NOT late AND NOT EXISTS(SELECT 1 FROM extraction_v2.receipts r WHERE r.response_ref=s.response_ref AND r.policy=%s)',[ref,self.policy]).fetchone()['n']
            unknown=pending or any(r.get('execution_status')=='UNKNOWN_HOLD' for r in rs)
            failed=any(r.get('execution_status')=='FAILED' for r in rs)
            truncated=any(r['delivery_status']=='KNOWN_INCOMPLETE' for r in rs)
            has_fact=any(r['candidate_refs'] for r in rs)
            has_entity=any(i.get('mention_ref') for r in rs for i in r['items'] if i['record']['kind']=='实体')
            legal=any(r['legal_no_knowledge'] for r in rs);usable=has_fact or has_entity or legal
            ended=bool(rs) and rs[-1]['end_declaration']=='EXPLICIT'
            turns={(r['delivery'].get('native_completion',{}).get('thread_id',r['identity'].get('thread_id')),r['delivery'].get('native_completion',{}).get('turn_id',r['identity'].get('turn_id'))) for r in rows if r['payload']['delivery_status']=='RETURNED'}
            eligible=bool(rs) and rs[-1]['delivery_status']=='RETURNED' and rs[-1]['end_declaration']=='MISSING' and len(turns)==1 and not unknown and not failed and not truncated and not force
            if unknown:status='UNKNOWN_HOLD'
            elif force:status=force
            elif failed:status='FAILED'
            elif truncated:status='PARTIAL'
            elif ended and usable:status='COMPLETED'
            elif eligible and not final:status='AWAIT_CONTINUATION'
            else:status='PARTIAL' if has_fact or has_entity else 'FAILED'
            freeze=final or status in ('COMPLETED','FAILED','UNKNOWN_HOLD') or ended or truncated
            q('UPDATE extraction_v2.tasks SET status=%s,frozen=%s WHERE task_ref=%s',[status,freeze,ref])
            return dict(**extra,task_ref=ref,status=status,execution_status=status,frozen=freeze,continue_eligible=eligible and not freeze,candidates=len({c for r in rs for c in r['candidate_refs']}))

    def read_run(self,run_id):
        with self.transaction(readonly=True) as (q,_):
            run=q('SELECT * FROM extraction_v2.runs WHERE run_id=%s',[run_id]).fetchone();require(run,'EXTRACTION_RUN_UNKNOWN');require(digest(run['manifest'])==run['sha256'],'EXTRACTION_PLAN_CHANGED');require(run['manifest'].get('reception_policy',POLICY_VERSION)==self.policy,'RUN_POLICY_MISMATCH')
            tasks=q('SELECT * FROM extraction_v2.tasks WHERE run_id=%s ORDER BY task_ref',[run_id]).fetchall();refs=[t['task_ref'] for t in tasks]
            candidates=q('SELECT * FROM extraction_v2.candidates WHERE task_ref=ANY(%s) ORDER BY candidate_ref',[refs]).fetchall()
            mentions=q('SELECT * FROM extraction_v2.mentions WHERE task_ref=ANY(%s) ORDER BY mention_ref',[refs]).fetchall()
            responses=q('SELECT * FROM extraction_v2.responses WHERE task_ref=ANY(%s) ORDER BY created_at,response_ref',[refs]).fetchall()
            receipts=q('SELECT r.payload FROM extraction_v2.receipts r JOIN extraction_v2.responses s USING(response_ref) WHERE s.task_ref=ANY(%s) ORDER BY s.created_at,s.response_ref',[refs]).fetchall()
        receipted={r['payload']['response_ref'] for r in receipts if r['payload']['policy']==self.policy}
        for task in tasks:
            pending=any(s['task_ref']==task['task_ref'] and not s['late'] and s['response_ref'] not in receipted for s in responses)
            if not task['frozen'] and (task['status']=='RUNNING' or pending):task['persisted_status']=task['status'];task['status']='UNKNOWN_HOLD'
        for row in responses:row['raw_hex']=bytes(row.pop('raw')).hex();row['created_at']=row['created_at'].isoformat()
        states=[t['status'] for t in tasks];usable=bool(candidates or mentions)
        plan_gaps=any(not g.get('nonblocking') for g in run['manifest'].get('gaps',[]))
        status='UNKNOWN_HOLD' if 'UNKNOWN_HOLD' in states else 'COMPLETED' if not plan_gaps and all(s in ('COMPLETED','NO_CANDIDATES') for s in states) else 'PARTIAL' if usable else 'FAILED'
        if self.v3 and status!='UNKNOWN_HOLD' and 'PARTIAL' in states:status='PARTIAL'
        extra={}
        if self.v3:
            active=[r['payload'] for r in receipts if r['payload']['policy']==self.policy and not r['payload']['late']]
            content_counts={k:sum(r.get('content_counts',{}).get(k,0) for r in active) for k in ('structured','open_only','skipped')}
            extra=dict(**open_content_summary(active),execution_status=status,alignment_status='NOT_ENABLED',namespace=self.schema,reception_policy=self.policy)
            for task in tasks:
                task.update(open_content_summary([r for r in active if r['task_ref']==task['task_ref']]),execution_status=task['status'])
        return dict(**extra,run_id=run_id,status=status,plan=run['manifest'],tasks=tasks,candidates=candidates,mentions=mentions,responses=responses,receipts=[r['payload'] for r in receipts],semantic_quality='UNASSESSED',publication='CANDIDATES_ONLY')
