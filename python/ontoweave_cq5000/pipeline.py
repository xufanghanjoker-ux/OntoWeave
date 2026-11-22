"""Versioned CQ5000 module orchestration, ending at CQ (no family/build stage)."""
import asyncio
import time
from pathlib import Path
from .compat import DEFAULT_HASHER, clone, text_field
from .dispatch import NativeInvocation, SKILL_PATH, SKILL_SHA256, verify_skill, tool_definition, block_prompt
from .errors import need
from .lifecycle import SingleCommit, MISSING
from .ranges import CONTRACT, work_blocks
from .receiver import KINDS, BlockReceiver, checked, immutable, aggregate_drafts
from .run import OPEN


def coverage_gaps(plan):
    def unrepresented(value):
        import re
        if isinstance(value, list):
            return sum(unrepresented(v) for v in value)
        if not isinstance(value, dict):
            return 0
        return sum(1 if key == 'status' and v == 'UNREPRESENTED' else len(v) if re.fullmatch(r'(?:unrepresented|uncovered|unprocessed)(?:_blocks|_items|_refs|_block_refs|_item_refs)?', key) and isinstance(v, list) else unrepresented(v) for key, v in value.items())
    import re
    return dict(plan_gaps=len(plan.get('gaps', [])), unrepresented_blocks=unrepresented(plan.get('coverage')),
                coverage_warnings=sum(bool(re.search('UNREPRESENTED|UNPROCESSED|UNCOVERED', w if isinstance(w, str) else w.get('code', ''))) for w in plan.get('warnings', [])))


class CQTools:
    def __init__(self, receiver, now):
        self.receiver = receiver
        self.lifecycle = SingleCommit(receiver, now=now, hasher=receiver.hasher)
        self.definitions = [tool_definition()]

    def call(self, name, args=MISSING, context=None):
        return self.lifecycle.call(name, args, context)

    async def call_async(self, name, args=MISSING, context=None):
        """Native async tool handlers offload synchronous signature/business work."""
        return await asyncio.to_thread(self.call, name, args, context)

    def is_complete(self):
        return self.receiver.saved is not None


class CQPipeline:
    """Same block order, <=4 lanes, durable saves and no automatic replay.

    The native transport owns app-server/Skill mounting and finite output format
    feedback, through NativeCodexPort; there is deliberately no provider client.
    PG receives the resulting frozen archive via pg_contract after offline gates.
    """
    def __init__(self, *, repo, source, plan, run, dispatcher, library_id, run_id, concurrency=4,
                 max_format_repairs=1, max_incomplete_continuations=2, assert_current=lambda: True,
                 runtime_directory=None, now=None, hasher=DEFAULT_HASHER):
        need(isinstance(concurrency, int) and not isinstance(concurrency, bool) and 1 <= concurrency <= 4, 'NATIVE_CHUNKED_CQ_CONCURRENCY_INVALID')
        need(plan.get('source_snapshot_ref') == source['snapshot_id'] and text_field(plan.get('plan_ref')) and isinstance(plan.get('chunks'), list), 'NATIVE_CHUNKED_CQ_PLAN_INVALID')
        need(plan.get('policy', {}).get('range_contract') == CONTRACT, 'NATIVE_CQ_PYTHON_CQ5000_ONLY')
        need(isinstance(max_format_repairs, int) and not isinstance(max_format_repairs, bool) and max_format_repairs in (0, 1) and isinstance(max_incomplete_continuations, int) and not isinstance(max_incomplete_continuations, bool) and 0 <= max_incomplete_continuations <= 2, 'NATIVE_CQ_FORMAT_POLICY_INVALID')
        self.repo, self.source, self.plan, self.parent = repo, clone(source), clone(plan), run
        self.dispatcher, self.library_id, self.run_id = dispatcher, library_id, run_id
        self.concurrency, self.repairs, self.continuations = concurrency, max_format_repairs, max_incomplete_continuations
        self._is_current, self.hasher = assert_current, hasher
        self.now = now or (lambda: int(time.time() * 1000))
        self.runtime_directory = Path(runtime_directory or '.')
        self.blocks = work_blocks(self.plan)
        need(isinstance(self.blocks, list), 'NATIVE_CHUNKED_CQ_WORK_WINDOWS_INVALID')
        self.binding = hasher.digest(dict(runId=run_id, libraryId=library_id, snapshotId=source['snapshot_id'], plan=plan,
                                         concurrency=concurrency, maxFormatRepairs=max_format_repairs, maxIncompleteContinuations=max_incomplete_continuations))
        self._validate_blocks()

    def _current(self):
        if not self._is_current():
            self.parent.stop('NATIVE_SOURCE_STALE', 'STALE')
            need(False, 'NATIVE_SOURCE_STALE')

    def _write_current(self):
        self._current()
        need(self.parent.state()['status'] not in ('CANCELLED', 'STALE'), 'NATIVE_CQ_WRITE_CLOSED')

    def _validate_blocks(self):
        self._current()
        seen = set()
        for block in self.blocks:
            doc = next((d for d in self.source['documents'] if d['doc_id'] == block.get('doc_ref')), None)
            text = block.get('contextualized_text')
            try:
                valid_text = isinstance(text, str) and text.encode('utf-16-le', 'surrogatepass').decode('utf-16-le') is not None
            except UnicodeError:
                valid_text = False
            count = block.get('token_count')
            need(doc is not None and doc['revision'] == block.get('revision') and text_field(block.get('chunk_ref')) and block['chunk_ref'] not in seen
                 and valid_text and isinstance(count, int) and not isinstance(count, bool) and 0 < count <= self.plan['policy']['max_tokens'], 'NATIVE_CHUNKED_CQ_CHUNK_INVALID')
            seen.add(block['chunk_ref'])

    def snapshot(self):
        state = self.repo.get_record(KINDS['state'], self.run_id)
        if state is None:
            return None
        state['chunks'] = [{**c, 'draft': checked(self.repo, KINDS['draft'], self.run_id + ':' + c['chunk_ref'], self.hasher)} for c in state['chunks']]
        state['merge'] = checked(self.repo, KINDS['merge'], self.run_id, self.hasher)
        state['policy'] = clone(self.plan['policy'])
        state['semantic_completeness_certified'] = False
        return state

    def _update(self, patch=None, block_index=None, block_patch=None):
        with self.repo.transaction():
            state = self.repo.get_record(KINDS['state'], self.run_id)
            state.update(clone(patch or {}))
            if block_index is not None:
                state['chunks'] = [{**c, **clone(block_patch)} if c['index'] == block_index else c for c in state['chunks']]
            self.repo.put_record(KINDS['state'], self.run_id, state)
            return state

    async def execute(self):
        self._current()
        verify_skill()
        old = self.repo.get_record(KINDS['state'], self.run_id)
        if old is not None:
            need(old['binding'] == self.binding, 'NATIVE_CHUNKED_CQ_BINDING_CHANGED')
            if old['execution_started']:
                need(old['status'] in ('COMPLETED', 'PARTIAL') and old.get('cq_input') is not None, 'NATIVE_CHUNKED_CQ_NO_AUTOMATIC_REPLAY')
                return {**clone(old['result']), 'execution_outcome': 'NO_AUTOMATIC_REPLAY'}
        immutable(self.repo, KINDS['plan'], self.run_id, dict(run_id=self.run_id, source_snapshot_ref=self.source['snapshot_id'], plan=self.plan), self.hasher)
        if old is None:
            self.repo.put_record(KINDS['state'], self.run_id, dict(version='native-chunked-cq/1', run_id=self.run_id, library_id=self.library_id,
                source_snapshot_ref=self.source['snapshot_id'], plan_ref=self.plan['plan_ref'], binding=self.binding, status='PLANNED', execution_started=False,
                chunks=[dict(chunk_ref=c['chunk_ref'], source_chunk_refs=clone(c.get('source_chunk_refs', [c['chunk_ref']])), index=i, status='PENDING') for i, c in enumerate(self.blocks)],
                cq_input=None, created_at=self.now()))
        self._current()
        self.parent.assert_open()
        remaining = self.parent.remaining()
        need(remaining is None or remaining >= len(self.blocks), 'NATIVE_CHUNKED_CQ_MINIMUM_BUDGET')
        self._update(dict(status='RUNNING', execution_started=True, started_at=self.now()))
        results, errors, next_index = [None] * len(self.blocks), [], 0

        async def process(block, index):
            receiver = BlockReceiver(repo=self.repo, run_id=self.run_id, snapshot_id=self.source['snapshot_id'], binding=self.binding,
                                     plan=self.plan, block=block, index=index, assert_current=self._write_current, hasher=self.hasher)
            tools = CQTools(receiver, self.now)
            request = NativeInvocation(role='CQ', agent_scope=block['chunk_ref'], prompt=block_prompt(block, self.plan, self.parent.remaining(), self.repairs, self.continuations),
                    skill_paths=(str(SKILL_PATH),), skill_sha256=SKILL_SHA256, model='qwen3.8-flash', max_format_repairs=self.repairs,
                    max_incomplete_continuations=self.continuations, runtime_directory=str(self.runtime_directory / 'cq' / block['chunk_ref']), run=self.parent, tools=tools)
            self._update(block_index=index, block_patch=dict(status='RUNNING'))
            response, error = None, None
            try:
                response = await self.dispatcher.invoke(request)
            except Exception as exc:
                error = exc
            receipt = response.get('receipt', response) if isinstance(response, dict) else None
            attempts = [a for a in self.parent.state()['attempts'] if a.get('agent_scope') == block['chunk_ref']]
            if any(a['outcome'] in ('UNKNOWN', 'RESERVED') for a in attempts):
                outcome = 'UNKNOWN'
            elif any(a['outcome'] == 'FAILED' for a in attempts):
                outcome = 'FAILED'
            else:
                outcome = 'RETURNED' if tools.is_complete() and attempts and all(a['outcome'] == 'RETURNED' for a in attempts) else 'FAILED'
            reason = getattr(error, 'code', None) or (receipt or {}).get('reason')
            result = dict(outcome=outcome, receipt=clone(receipt), request_refs=[a['request_ref'] for a in attempts])
            if reason:
                result['error'] = dict(code=reason)
            self._update(block_index=index, block_patch=dict(status=outcome, **result, item_count=len(receiver.saved['items']) if receiver.saved else 0))
            if outcome != 'RETURNED':
                self.parent.stop(reason or 'NATIVE_CHUNKED_CQ_' + outcome, 'UNKNOWN_HOLD' if outcome == 'UNKNOWN' else 'FAILED')
            return dict(chunk_ref=block['chunk_ref'], index=index, **result, saved=receiver.saved is not None)

        async def lane():
            nonlocal next_index
            while next_index < len(self.blocks) and self.parent.state()['status'] in OPEN and not errors:
                index = next_index
                next_index += 1
                try:
                    self._current()
                    self.parent.assert_open()
                    results[index] = await process(self.blocks[index], index)
                except Exception as exc:
                    errors.append(exc)
                    code = getattr(exc, 'code', 'NATIVE_CHUNKED_CQ_FAILED')
                    self.parent.stop(code, 'FAILED')
                    self._update(block_index=index, block_patch=dict(status='FAILED', error=dict(code=code)))
        await asyncio.gather(*(lane() for _ in range(min(self.concurrency, max(1, len(self.blocks))))))
        ledger = self.parent.state()
        settled = [b for b, r in zip(self.blocks, results) if r and r['outcome'] == 'RETURNED']
        partial = len(settled) != len(self.blocks) or ledger['status'] not in OPEN
        if partial and not settled:
            code = getattr(errors[0], 'code', 'NATIVE_CHUNKED_CQ_FAILED') if errors else ledger.get('reason', 'NATIVE_CHUNKED_CQ_INCOMPLETE')
            self._update(dict(status=ledger['status'], reason=code, ended_at=self.now()))
            need(False, code)
        self._write_current()
        drafts = [checked(self.repo, KINDS['draft'], self.run_id + ':' + b['chunk_ref'], self.hasher) for b in settled]
        windows = self.repo.get_record(KINDS['state'], self.run_id)['chunks']
        execution_gaps = [
            dict(chunk_ref=c['chunk_ref'], status=c['status'] if c['status'] != 'PENDING' else 'NOT_DISPATCHED',
                 request_refs=c.get('request_refs', []), error=c.get('error'))
            for c in windows if c['status'] != 'RETURNED'
        ]
        self._update(dict(status='MERGING'))
        merge = aggregate_drafts(run_id=self.run_id, snapshot_id=self.source['snapshot_id'], binding=self.binding, plan=self.plan, drafts=drafts, hasher=self.hasher)
        immutable(self.repo, KINDS['merge'], self.run_id, {k: v for k, v in merge.items() if k != 'record_sha256'}, self.hasher)
        gaps = coverage_gaps(self.plan)
        scan = 'PARTIAL' if partial or any(gaps.values()) else 'COMPLETE'
        all_items = [q for d in drafts for q in d['items']]
        summary = dict(chunks=len(self.blocks), base_chunk_count=len(self.plan['chunks']), work_window_count=len(self.blocks), processed_work_windows=len(settled),
                       processed_chunks=len(set(r for c in settled for r in c.get('source_chunk_refs', [c['chunk_ref']]))), chunk_drafts=len(all_items), cqs=len(merge['cq_input']['items']),
                       chunk_warnings=sum(len(d['warnings']) for d in drafts), merge_warnings=0, **gaps, merge_mode=merge['mode'], merge_semantic_status=merge['semantic_status'],
                       range_contract=CONTRACT, range_status_summary={s: sum(q['range_status'] == s for q in merge['cq_input']['items']) for s in ('UNIT_RANGES', 'BLOCK_FALLBACK_PRESENT')},
                       quality_status='UNASSESSED', aggregation_model_requests=0, token_count_strategy=self.plan['policy'].get('tokenizer', 'cl100k_base'),
                       coverage_precision='FROZEN_UNIT_FRAGMENTS_NOT_ORIGINAL_FILE_CHARACTER_OFFSETS', semantic_completeness_certified=False)
        result = dict(cq_input=clone(merge['cq_input']), scan_status=scan, summary=summary, chunk_results=results, execution_gaps=execution_gaps,
                      merge_result=dict(outcome='RETURNED', execution_mode='HOST_EXACT_DEDUP', request_refs=[]))
        self._update(dict(status='PARTIAL' if partial else 'COMPLETED', execution_gaps=execution_gaps, cq_input=clone(merge['cq_input']), scan_status=scan, summary=summary, result=result, ended_at=self.now()))
        return result
