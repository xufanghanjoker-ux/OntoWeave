"""CQ5000 receiver and conservative view, preserving frozen JS IDs/signatures."""
import json
import threading
from .compat import DEFAULT_HASHER, clone, distinct, js_keys, text_field, trim
from .errors import CQError, need
from .ranges import resolve_unit_ranges, aggregate_range_items, can_aggregate, work_blocks

KINDS = dict(state='native_chunked_cq_state_v1', plan='native_chunked_cq_plan_v1', draft='native_cq_chunk_draft_v1',
             read='native_cq_chunk_read_receipt_v1', merge='native_cq_chunk_merge_v1')
SAVE = 'lightog_save_cq_list'


def seal(body, hasher=DEFAULT_HASHER):
    return {**clone(body), 'record_sha256': hasher.digest(body)}


def immutable(repo, kind, key, body, hasher=DEFAULT_HASHER):
    value, old = seal(body, hasher), repo.get_record(kind, key)
    need(old is None or hasher.digest(old) == hasher.digest(value), 'NATIVE_CHUNKED_CQ_IMMUTABLE_CONFLICT')
    if old is None:
        repo.put_record(kind, key, value)
    return value


def checked(repo, kind, key, hasher=DEFAULT_HASHER):
    row = repo.get_record(kind, key)
    if row is None:
        return None
    need(row.get('record_sha256') == hasher.digest({k: v for k, v in row.items() if k != 'record_sha256'}), 'NATIVE_CHUNKED_CQ_RECORD_CHANGED')
    return row


def canonical_item(run_id, snapshot_id, input_ref, index, item, sources, read_refs, hasher=DEFAULT_HASHER):
    q = dict(cq_ref='native_cq_' + hasher.digest([run_id, snapshot_id, input_ref, index, item['question']]), question=item['question'])
    for key in ('notes', 'source_hint'):
        if item.get(key):
            q[key] = item[key]
    q.update(source_refs=clone(sources), read_receipt_refs=list(dict.fromkeys(read_refs)), source_status='KNOWN' if sources else 'UNKNOWN')
    if not sources:
        q['source_unknown_reason'] = '未能将本题可靠对应到本轮已保存的分块草稿；原稿及处理告警保留。'
    return q


def business_items(proposal, warnings):
    rows = []
    for index, item in enumerate(proposal['items']):
        if not isinstance(item, dict) or not text_field(item.get('question')):
            warnings.append(dict(code='CQ_ITEM_SKIPPED', index=index))
            continue
        row = dict(question=trim(item['question']), proposal_index=index)
        for key in ('source_hint', 'notes'):
            if key in item:
                if text_field(item[key]):
                    row[key] = trim(item[key])
                else:
                    warnings.append(dict(code='CQ_OPTIONAL_FIELD_IGNORED', index=index, field=key))
        for key in js_keys(item):
            if key not in ('question', 'source_hint', 'notes', 'source_draft_refs', 'ranges'):
                warnings.append(dict(code='CQ_EXTRA_FIELD_IGNORED', index=index, field=key))
        row['ranges'] = clone(item.get('ranges'))
        if 'source_draft_refs' in item:
            row['source_draft_refs'] = clone(item['source_draft_refs'])
        rows.append(row)
    return rows


class BlockReceiver:
    def __init__(self, *, repo, run_id, snapshot_id, binding, plan, block, index,
                 assert_current=lambda: None, hasher=DEFAULT_HASHER):
        self.repo, self.run_id, self.snapshot_id, self.binding = repo, run_id, snapshot_id, binding
        self.plan, self.block, self.index = plan, block, index
        self.assert_current, self.hasher = assert_current, hasher
        self.key = run_id + ':' + block['chunk_ref']
        self.saved = None
        self._lock = threading.RLock()

    def receipt(self, record):
        return dict(ok=True, result=dict(saved=True, stage_complete=True, parent_run_complete=False,
                    processed=len(record['items']), processing_summary=clone(record['processing_summary']), warnings=clone(record['warnings'])))

    def reconcile(self, name, proposal):
        self.assert_current()
        record = self.repo.get_record(KINDS['draft'], self.key)
        if record is None:
            return None
        need(record.get('record_sha256') == self.hasher.digest({k:v for k,v in record.items() if k!='record_sha256'}) and record['run_id'] == self.run_id and record['source_snapshot_ref'] == self.snapshot_id and
             record['chunk_ref'] == self.block['chunk_ref'], 'NATIVE_CHUNKED_CQ_DRAFT_CHANGED')
        if name != SAVE or self.hasher.digest(record['raw_proposal']) != self.hasher.digest(proposal):
            return None
        self.saved = record
        return self.receipt(record)

    def save_raw(self, raw_bytes, name=SAVE):
        """Keep original bytes/signature apart from decoded proposal or projections."""
        from .compat import sha
        data = bytes(raw_bytes)
        key = self.hasher.digest([self.run_id, self.block['chunk_ref'], sha(data)])
        self.repo.put_record('cq_python_raw_arguments_v1', key, dict(run_id=self.run_id, chunk_ref=self.block['chunk_ref'],
                             bytes=data, bytes_sha256=sha(data), serialization='ORIGINAL_ARGUMENT_BYTES'))
        try:
            proposal = json.loads(data)
        except (ValueError, UnicodeError):
            return dict(ok=False, error=dict(code='NATIVE_TOOL_ARGUMENTS_JSON_INVALID'))
        return self.call(name, proposal)

    def call(self, name, proposal):
        with self._lock:
            self.assert_current()
            if name != SAVE:
                return dict(ok=False, error=dict(code='NATIVE_CHUNKED_CQ_TOOL_FORBIDDEN'))
            if self.saved is not None:
                if self.hasher.digest(self.saved['raw_proposal']) == self.hasher.digest(proposal):
                    return self.receipt(self.saved)
                diagnostic = dict(run_id=self.run_id, scope=self.block['chunk_ref'], original_record_sha256=self.saved['record_sha256'],
                                  raw_proposal=clone(proposal), reason='LATE_CONFLICT_PRESERVED')
                self.repo.put_record('native_chunked_cq_late_submit_v1', self.hasher.digest(diagnostic), diagnostic)
                return dict(ok=True, result=dict(accepted=False, saved=False, reason='LATE_CONFLICT_PRESERVED'))
            def reject(code):
                immutable(self.repo, 'native_cq_chunk_rejected_proposal_v1', self.hasher.digest([self.run_id, self.block['chunk_ref'], proposal, code]),
                          dict(run_id=self.run_id, chunk_ref=self.block['chunk_ref'], source_snapshot_ref=self.snapshot_id,
                               raw_proposal=clone(proposal), error_code=code), self.hasher)
                return dict(ok=False, execution_outcome='LOCAL_REJECT', error=dict(code=code))
            if not isinstance(proposal, dict) or not isinstance(proposal.get('items'), list):
                return reject('CQ_ITEMS_INVALID')
            warnings = []
            all_rows = business_items(proposal, warnings)
            rows = all_rows[:5]
            if len(all_rows) > 5:
                warnings.append(dict(code='CQ_OVER_FIVE_TRUNCATED', submitted_valid=len(all_rows)))
            if proposal['items'] and not all_rows:
                return reject('CQ_NO_VALID_QUESTIONS')
            block = self.block
            read_ref = 'cq_chunk_read_' + self.hasher.digest([self.run_id, self.plan['plan_ref'], block['chunk_ref']])
            read = immutable(self.repo, KINDS['read'], read_ref, dict(read_receipt_ref=read_ref, run_id=self.run_id,
                             source_snapshot_ref=self.snapshot_id, chunk_ref=block['chunk_ref'],
                             source_ref=dict(doc_ref=block['doc_ref'], revision=block['revision']),
                             source_chunk_refs=clone(block.get('source_chunk_refs', [block['chunk_ref']])),
                             material_sha256=self.hasher.digest(block['contextualized_text']), source_block_refs=clone(block.get('source_block_refs', [])),
                             source_items=clone(block.get('source_items', [])), delivery='HOST_PROMPT_CONTEXT_PROVIDED', semantic_reading_certified=False), self.hasher)
            input_ref = 'cq_chunk_input_' + self.hasher.digest([self.binding, block['chunk_ref'], rows])
            items = []
            for i, item in enumerate(rows):
                q = canonical_item(self.run_id, self.snapshot_id, input_ref, i, item, [read['source_ref']], [read_ref], self.hasher)
                located = resolve_unit_ranges(block, item['ranges'], self.hasher)
                warnings.extend({**w, 'proposal_index': item['proposal_index']} for w in located['range_warnings'])
                items.append({**q, **located})
            body = dict(run_id=self.run_id, source_snapshot_ref=self.snapshot_id, chunk_ref=block['chunk_ref'], index=self.index,
                        doc_ref=block['doc_ref'], revision=block['revision'], input_ref=input_ref, raw_proposal=clone(proposal),
                        items=items, read_receipt_ref=read_ref, warnings=warnings,
                        processing_summary=dict(submitted=len(proposal['items']), saved=len(items), skipped=len(proposal['items']) - len(items), warning_count=len(warnings)))
            # Mark in-memory completion only after durable write succeeds.
            record = immutable(self.repo, KINDS['draft'], self.key, body, self.hasher)
            self.saved = record
            return self.receipt(record)


def aggregate_drafts(*, run_id, snapshot_id, binding, plan, drafts, hasher=DEFAULT_HASHER):
    """The existing conservative view: no semantic model, embedding or reranker."""
    blocks = work_blocks(plan)
    counts = {}
    for b in blocks:
        counts[b['doc_ref']] = counts.get(b['doc_ref'], 0) + 1
    by_block = {d['chunk_ref']: d for d in drafts}
    flat = [dict(item=item, chunk_ref=b['chunk_ref']) for b in blocks if b['chunk_ref'] in by_block for item in by_block[b['chunk_ref']]['items']]
    numbered = [{**d, 'draft_ref': 'draft_' + str(i + 1).zfill(4)} for i, d in enumerate(flat)]
    groups = []
    for draft in numbered:
        group = next((g for g in groups if any(counts.get(a['item']['source_refs'][0]['doc_ref'], 0) > 1 and can_aggregate(a['item'], draft['item']) for a in g['origins'])), None)
        if group is None:
            groups.append(dict(item=draft['item'], origins=[draft], action='HOST_COPIED_DRAFT'))
        else:
            group['origins'].append(draft)
            group['action'] = 'HOST_EXACT_DUPLICATES'
    mode, args = 'HOST_CONSERVATIVE_RANGE_DEDUP_V1', {'items': []}
    input_ref = 'native_cq_input_' + hasher.digest([binding, mode, args])
    items, mapping = [], []
    for group in groups:
        origins = list({d['draft_ref']: d for d in group['origins']}.values())
        sources = distinct([s for d in origins for s in d['item']['source_refs']], hasher)
        read_refs = [r for d in origins for r in d['item']['read_receipt_refs']]
        q = canonical_item(run_id, snapshot_id, input_ref, len(items), group['item'], sources, read_refs, hasher)
        q.update(aggregate_range_items([d['item'] for d in origins], plan, hasher))
        items.append(q)
        mapping.append(dict(cq_ref=q['cq_ref'], source_draft_refs=[d['draft_ref'] for d in origins], origin_cq_refs=[d['item']['cq_ref'] for d in origins],
                            origin_chunk_refs=list(dict.fromkeys(d['chunk_ref'] for d in origins)), action=group['action']))
    cq_input = dict(input_ref=input_ref, run_id=run_id, source_snapshot_ref=snapshot_id, items=items)
    return seal(dict(run_id=run_id, source_snapshot_ref=snapshot_id, plan_ref=plan['plan_ref'], raw_proposal=args, mode=mode,
                     semantic_status='NOT_NEEDED_SINGLE_WINDOW' if len(blocks) <= 1 else 'NOT_PERFORMED',
                     drafts=[dict(draft_ref=d['draft_ref'], origin_cq_ref=d['item']['cq_ref'], chunk_ref=d['chunk_ref']) for d in numbered], cq_input=cq_input,
                     mapping=mapping, warnings=[], processing_summary=dict(drafts=len(numbered), submitted=0, saved=len(items),
                     exact_duplicates=len(numbered) - len(groups), preserved_unreferenced=0, warning_count=0)), hasher)
