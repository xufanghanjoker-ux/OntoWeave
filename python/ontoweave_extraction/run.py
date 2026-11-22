"""Thin extraction role ledger; existing native transport owns provider requests."""
import time,uuid
from ontoweave_cq.store import require
class ExtractionRun:
    def __init__(self,repo,run_id):
        self.repo,self.run_id=repo,run_id
        with repo.transaction():
            require(repo.get_record('extraction_runtime',run_id) is None,'NO_AUTOMATIC_RUNTIME_REPLAY')
            repo.put_record('extraction_runtime',run_id,dict(run_id=run_id,status='OPEN',created_at=self.now(),last_progress_at=self.now(),started_at=None,attempts=[],limits=dict(max_generation_requests=None,max_embedding_batches=None,max_embedding_items=None,max_embedding_text_chars=None,max_total_bytes=None,max_wall_ms=None,max_request_bytes=2097152,max_response_bytes=16777216,max_request_ms=600000,max_no_progress_ms=900000,max_stalled_tool_calls=3),input=dict(execution_policy='PROGRESS_GOVERNED_V1')))
    def now(self):return int(time.time()*1000)
    def state(self):return self.repo.get_record('extraction_runtime',self.run_id)
    def assert_open(self):
        s=self.state();require(s['status'] in ('OPEN','RUNNING'),'EXTRACTION_RUNTIME_NOT_OPEN');require(self.now()-s['last_progress_at']<s['limits']['max_no_progress_ms'],'EXTRACTION_RUNTIME_TIMEOUT');return s
    def stop(self,reason,status='STOPPED'):
        with self.repo.transaction():
            s=self.state()
            if s['status'] in ('OPEN','RUNNING'):s.update(status=status,reason=reason,ended_at=self.now());self.repo.put_record('extraction_runtime',self.run_id,s)
            return s
    def reserve(self,*,agent_scope,request_bytes=0):
        with self.repo.transaction():
            dispatch_guard = getattr(getattr(self.repo, "store", None), "product_dispatch_guard", None)
            if dispatch_guard is not None:
                dispatch_guard(self.repo.local.q)
            s=self.assert_open();require(not any(a['outcome']=='RESERVED' for a in s['attempts']),'REQUEST_IN_FLIGHT');require(request_bytes<=s['limits']['max_request_bytes'],'REQUEST_TOO_LARGE')
            ref='extraction_request_'+uuid.uuid4().hex;s['attempts'].append(dict(request_ref=ref,request_id=ref,kind='GENERATION',role='EXTRACTION',agent_scope=agent_scope,outcome='RESERVED',request_bytes=request_bytes,sent_at=self.now()));s.update(status='RUNNING',started_at=s['started_at'] or self.now());self.repo.put_record('extraction_runtime',self.run_id,s)
            return dict(request_ref=ref,request_id=ref,remaining_ms=s['limits']['max_request_ms'])
    def settle(self,ref,*,outcome,usage=None,reason=None):
        with self.repo.transaction():
            s=self.state();a=next((a for a in s['attempts'] if a['request_ref']==ref),None);require(a,'REQUEST_UNKNOWN');require(a['outcome'] in ('RESERVED',outcome),'SETTLEMENT_CONFLICT')
            a.update(outcome=outcome,usage=usage,reason=reason,ended_at=self.now());self.repo.put_record('extraction_runtime',self.run_id,s)
            if outcome!='RETURNED':self.stop(reason or outcome,'UNKNOWN_HOLD' if outcome=='UNKNOWN' else 'FAILED')
            return a
    def note_progress(self):
        with self.repo.transaction():
            s=self.state();s['last_progress_at']=self.now();self.repo.put_record('extraction_runtime',self.run_id,s);return s['last_progress_at']
