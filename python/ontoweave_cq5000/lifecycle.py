"""Existing SINGLE_COMMIT save/receipt semantics, including crash reconciliation."""
import threading
import weakref
from .compat import DEFAULT_HASHER, clone
from .errors import need
from .receiver import seal

MISSING = object()
KIND = 'native_agent_save_finish_v1'
_LOCKS = weakref.WeakKeyDictionary()
_LOCK_GUARD = threading.Lock()


class SingleCommit:
    def __init__(self, receiver, *, now=lambda: 0, hasher=DEFAULT_HASHER):
        self.receiver, self.repo, self.now, self.hasher = receiver, receiver.repo, now, hasher
        self.profile = dict(mode='SINGLE_COMMIT', save=['lightog_save_cq_list'])
        self.id = hasher.digest(dict(run_id=receiver.run_id, role='CQ', scope=receiver.block['chunk_ref']))
        self.binding = hasher.digest(self.profile)
        with _LOCK_GUARD:
            self.lock = _LOCKS.setdefault(self.repo, {}).setdefault(self.id, threading.RLock())

    def _load(self):
        row = self.repo.get_record(KIND, self.id)
        if row is not None:
            body = {k: v for k, v in row.items() if k != 'record_sha256'}
            need(row['record_sha256'] == self.hasher.digest(body) and row['binding'] == self.binding, 'NATIVE_LIFECYCLE_BINDING_CHANGED')
            return row
        return dict(version=1, run_id=self.receiver.run_id, role='CQ', scope=self.receiver.block['chunk_ref'], binding=self.binding,
                    status='OPEN', operations=[], diagnostics=[])

    def _write(self, state):
        self.repo.put_record(KIND, self.id, seal({k: v for k, v in state.items() if k != 'record_sha256'}, self.hasher))

    def call(self, name, args=MISSING, context=None):
        args = {} if args is MISSING else args
        with self.lock:
            self.receiver.assert_current()
            if name not in self.profile['save']:
                return self.receiver.call(name, args)
            state = self._load()
            key = self.hasher.digest(dict(name=name, args=args))
            prior = next((o for o in state['operations'] if o['key'] == key), None)
            if prior:
                recovered = self.receiver.reconcile(name, args)
                if prior['status'] == 'COMMITTED':
                    need(recovered is not None and self.hasher.digest(recovered) == self.hasher.digest(prior['receipt']), 'NATIVE_LIFECYCLE_COMMITTED_OUTPUT_CHANGED')
                    return clone(prior['receipt'])
                if recovered is not None:
                    prior.update(status='COMMITTED', receipt=clone(recovered), reconciled_at=self.now())
                    state['status'] = 'COMMITTED'
                    self._write(state)
                    return recovered
                return self._denied(state, name, args, 'INTERRUPTED_COMMIT_REQUIRES_RECONCILIATION')
            if state['status'] in ('COMMITTED', 'FINISHED'):
                return self._denied(state, name, args, 'LATE_CONFLICT_PRESERVED')
            operation = dict(key=key, name=name, args=clone(args), context=clone(context or {}), status='PREPARED', at=self.now())
            state['operations'].append(operation)
            self._write(state)
            try:
                receipt = self.receiver.call(name, args)
            except Exception as exc:
                operation.update(status='UNCONFIRMED', error_code=getattr(exc, 'code', 'NATIVE_LIFECYCLE_INTERRUPTED'))
                self._write(state)
                receipt = self.receiver.reconcile(name, args)
                if receipt is None:
                    raise
            if receipt.get('ok') is False or receipt.get('result', {}).get('accepted') is False:
                state['operations'] = [o for o in state['operations'] if o['key'] != key]
                self._write(state)
                return receipt
            operation.update(status='COMMITTED', receipt=clone(receipt), committed_at=self.now())
            state['status'] = 'COMMITTED'
            self._write(state)
            return receipt

    def _denied(self, state, name, args, reason):
        state['diagnostics'].append(dict(name=name, args=clone(args), reason=reason, at=self.now()))
        self._write(state)
        receipt = next((o.get('receipt') for o in state['operations'] if o['status'] == 'COMMITTED'), None)
        if reason == 'INTERRUPTED_COMMIT_REQUIRES_RECONCILIATION':
            return dict(ok=False, execution_outcome='UNKNOWN_HOLD', error=dict(code=reason),
                        result=dict(accepted=False, saved=False))
        return dict(ok=True, result=dict(accepted=False, saved=False, lifecycle=dict(status=state['status'], reason=reason, original_receipt=receipt)))
