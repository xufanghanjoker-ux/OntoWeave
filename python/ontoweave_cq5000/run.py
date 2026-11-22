"""CQ-only counted run port. Persistence is injected, never SQL here."""
import time
import uuid
from .compat import DEFAULT_HASHER, clone, text_field
from .errors import need

OPEN = ('OPEN', 'RUNNING')
KIND = 'native_full_run_v1'
NORMAL_LIMITS = dict(max_generation_requests=None,max_embedding_batches=None,max_embedding_items=None,max_embedding_text_chars=None,max_total_bytes=None,max_wall_ms=None,max_request_bytes=1048576,max_response_bytes=16777216,max_request_ms=600000,max_no_progress_ms=900000,max_stalled_tool_calls=3)
DEFAULT_LIMITS = dict(max_generation_requests=16, max_embedding_batches=12, max_embedding_items=200,
                      max_embedding_text_chars=120000, max_request_bytes=1048576, max_total_bytes=8388608,
                      max_response_bytes=16777216, max_wall_ms=600000)


class CQRun:
    def __init__(self, repo, run_id, input, limits=None, *, now=None, hasher=DEFAULT_HASHER):
        self.repo, self.run_id, self.hasher = repo, run_id, hasher
        self.now = now or (lambda: int(time.time() * 1000))
        self.normal = input.get('execution_policy') == 'PROGRESS_GOVERNED_V1'
        self.limits = {**(NORMAL_LIMITS if self.normal else DEFAULT_LIMITS), **(limits or {})}
        need(all(isinstance(v, int) and not isinstance(v, bool) and v >= (0 if k in ('max_generation_requests', 'max_embedding_batches', 'max_embedding_items', 'max_embedding_text_chars') else 1) if not (self.normal and k in NORMAL_LIMITS and NORMAL_LIMITS[k] is None) else v is None for k, v in self.limits.items()), 'NATIVE_RUN_LIMIT_INVALID')
        binding = hasher.digest(dict(input=input, limits=self.limits))
        with repo.transaction():
            old = repo.get_record(KIND, run_id)
            if old is not None:
                need(old['binding'] == binding, 'NATIVE_RUN_BINDING_CONFLICT')
                if any(a['outcome'] == 'RESERVED' for a in old['attempts']):
                    old.update(status='UNKNOWN_HOLD', reason='NATIVE_RUN_INTERRUPTED_RESULT_UNKNOWN')
                    for a in old['attempts']:
                        if a['outcome'] == 'RESERVED':
                            a.update(outcome='UNKNOWN', reason=old['reason'])
                    repo.put_record(KIND, run_id, old)
            else:
                repo.put_record(KIND, run_id, dict(run_id=run_id, mode='NATIVE_CQ_BUILD_V1', binding=binding, input=clone(input), limits=self.limits,
                                status='OPEN', created_at=self.now(), started_at=None, ended_at=None, attempts=[], checkpoints=[], **({'last_progress_at':self.now()} if self.normal else {})))

    def state(self):
        return self.repo.get_record(KIND, self.run_id)

    def remaining(self):
        s = self.state()
        return None if self.normal else s['limits']['max_generation_requests'] - sum(a['kind'] == 'GENERATION' for a in s['attempts'])

    def assert_open(self):
        s = self.state()
        need(s['status'] in OPEN, 'NATIVE_RUN_' + s['status'])
        if self.normal and self.now()-s.get('last_progress_at',s['created_at'])>=s['limits']['max_no_progress_ms']:
            self.stop('NATIVE_NO_PROGRESS_TIMEOUT')
            need(False, 'NATIVE_NO_PROGRESS_TIMEOUT')
        if not self.normal and s['started_at'] is not None and self.now() - s['started_at'] >= s['limits']['max_wall_ms']:
            self.stop('NATIVE_RUN_DEADLINE')
            need(False, 'NATIVE_RUN_DEADLINE')
        return s

    def stop(self, reason, status='STOPPED'):
        with self.repo.transaction():
            s = self.state()
            if s['status'] in OPEN:
                need(status in ('STOPPED', 'FAILED', 'UNKNOWN_HOLD', 'STALE', 'CANCELLED'), 'NATIVE_RUN_STOP_STATUS_INVALID')
                s.update(status=status, reason=reason, ended_at=self.now())
                self.repo.put_record(KIND, self.run_id, s)
            return s

    def reserve(self, *, agent_scope, request_bytes=0):
        self.assert_open()
        denial = None
        with self.repo.transaction():
            s = self.assert_open()
            need(text_field(agent_scope), 'NATIVE_REQUEST_SCOPE_INVALID')
            pending = [a for a in s['attempts'] if a['outcome'] == 'RESERVED']
            need(all(a['role'] == 'CQ' and a['agent_scope'] != agent_scope for a in pending), 'NATIVE_RUN_CONCURRENT_REQUEST_FORBIDDEN')
            concurrency = s['input'].get('cq_chunk_policy', {}).get('concurrency', 4)
            need(isinstance(concurrency, int) and 0 < concurrency <= 4 and len(pending) < concurrency, 'NATIVE_RUN_PARALLEL_LIMIT')
            need(isinstance(request_bytes, int) and not isinstance(request_bytes, bool) and request_bytes >= 0, 'NATIVE_REQUEST_SIZE_INVALID')
            if request_bytes > s['limits']['max_request_bytes']:
                denial = 'NATIVE_REQUEST_TOO_LARGE'
            elif not self.normal and sum(a['request_bytes'] for a in s['attempts']) + request_bytes > s['limits']['max_total_bytes']:
                denial = 'NATIVE_TOTAL_BYTES_EXCEEDED'
            elif not self.normal and self.remaining() <= 0:
                denial = 'NATIVE_GENERATION_LIMIT'
            if denial:
                s.update(status='STOPPED', reason=denial, ended_at=self.now())
            else:
                if s['started_at'] is None:
                    s['started_at'] = self.now()
                s['status'] = 'RUNNING'
                ref = 'native_request_' + str(uuid.uuid4())
                s['attempts'].append(dict(request_ref=ref, request_id=ref, kind='GENERATION', role='CQ', agent_scope=agent_scope,
                                          request_bytes=request_bytes, items=0, text_chars=0, outcome='RESERVED', sent_at=self.now()))
            self.repo.put_record(KIND, self.run_id, s)
        need(denial is None, denial)
        return dict(request_ref=ref, request_id=ref, remaining_ms=s['limits']['max_request_ms'] if self.normal else max(1, s['limits']['max_wall_ms'] - (self.now() - s['started_at'])))

    def settle(self, request_ref, *, outcome, usage=None, reason=None):
        need(outcome in ('RETURNED', 'FAILED', 'UNKNOWN'), 'NATIVE_REQUEST_OUTCOME_INVALID')
        with self.repo.transaction():
            s = self.state()
            a = next((a for a in s['attempts'] if a['request_ref'] == request_ref), None)
            need(a is not None, 'NATIVE_REQUEST_UNKNOWN')
            if a['outcome'] != 'RESERVED':
                need(a['outcome'] == outcome, 'NATIVE_SETTLEMENT_CONFLICT')
                return clone(a)
            a.update(outcome=outcome, usage=clone(usage), reason=reason, ended_at=self.now())
            if outcome != 'RETURNED':
                if s['status'] != 'UNKNOWN_HOLD' or outcome == 'UNKNOWN':
                    s.update(status='UNKNOWN_HOLD' if outcome == 'UNKNOWN' else 'FAILED', reason=reason or 'NATIVE_REQUEST_' + outcome)
                s['ended_at'] = self.now()
            self.repo.put_record(KIND, self.run_id, s)
            return clone(a)

    def note_progress(self):
        if not self.normal:
            return None
        with self.repo.transaction():
            s=self.state()
            if s['status'] in OPEN:
                s['last_progress_at']=self.now()
                self.repo.put_record(KIND,self.run_id,s)
            return s.get('last_progress_at')
