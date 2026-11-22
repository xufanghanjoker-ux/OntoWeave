"""PG contract v1 provider: normalized CQ view, no database/storage writer."""
import json
from .compat import DEFAULT_HASHER, clone, dump, sha, text_field
from .errors import CQError, need
from .ranges import CONTRACT, work_blocks, range_units, load_range_materials


def prepare_archive(input, hasher=DEFAULT_HASHER):
    archive_id, artifacts = input['archive_id'], input['artifacts']
    need(isinstance(archive_id, str) and bool(archive_id), 'PG_CQ_ARCHIVE_ID_REQUIRED')
    need(len({a['name'] for a in artifacts}) == len(artifacts), 'PG_CQ_ARTIFACT_NAMES_INVALID')
    def role(name):
        rows = [a for a in artifacts if a['role'] == name]
        need(len(rows) == 1, 'PG_CQ_ARTIFACT_ROLE_REQUIRED')
        return json.loads(rows[0]['bytes'])
    plan, result, snapshot = role('plan'), role('result'), role('snapshot')
    need(plan.get('policy', {}).get('range_contract') == CONTRACT and plan['policy'].get('max_tokens') == 5000, 'PG_CQ_POLICY_UNSUPPORTED')
    run_id, merge = result['run_id'], result['chunked']['merge']
    blocks, docs = work_blocks(plan), snapshot['documents']
    block_map = {b['chunk_ref']: b for b in blocks}
    chunked = result['chunked']
    chunks = chunked['chunks']
    if chunked.get('status') == 'PARTIAL':
        settled = [c for c in chunks if c['status'] == 'RETURNED']
        missing = {c['chunk_ref'] for c in chunks if c['status'] != 'RETURNED'}
        gaps = chunked['execution_gaps']
        need(set(block_map) == {c['chunk_ref'] for c in chunks} and len(chunks) == len(blocks)
             and missing == {g['chunk_ref'] for g in gaps} and bool(settled)
             and all(c.get('request_refs') and c.get('draft') for c in settled),
             'PG_CQ_PARTIAL_COVERAGE_INVALID')
        drafts = [c['draft'] for c in settled]
    else:
        drafts = [c['draft'] for c in chunks]
    need(len(block_map) == len(blocks), 'PG_CQ_DUPLICATE_BLOCK')
    need(merge['run_id'] == run_id and merge['plan_ref'] == plan['plan_ref'] and
         merge['source_snapshot_ref'] == snapshot['snapshot_id'] == plan['source_snapshot_ref'], 'PG_CQ_BINDING_MISMATCH')
    for b in blocks:
        need(b['plan_ref'] == plan['plan_ref'] and any(d['doc_id'] == b['doc_ref'] and d['revision'] == b['revision'] for d in docs), 'PG_CQ_BLOCK_VERSION_MISMATCH')
        need(b.get('manifest_ref') and isinstance(b.get('units'), list) and all(sha(u['text']) == u['text_sha256'] for u in b['units']), 'PG_CQ_UNIT_SHA_CHANGED')
    local = {}
    for d in drafts:
        b = block_map.get(d['chunk_ref'])
        need(d['run_id'] == run_id and d['source_snapshot_ref'] == snapshot['snapshot_id'] and b is not None and
             b['doc_ref'] == d['doc_ref'] and b['revision'] == d['revision'] and len(d['items']) <= 5, 'PG_CQ_DRAFT_BINDING_MISMATCH')
        for item in d['items']:
            need(item['cq_ref'] not in local or local[item['cq_ref']] == item, 'PG_CQ_LOCAL_CONFLICT')
            local[item['cq_ref']] = item
    if chunked.get('status') == 'PARTIAL':
        need(len(gaps) == len(missing) and all(g['status'] in ('FAILED', 'UNKNOWN', 'NOT_DISPATCHED') for g in gaps)
             and {d['origin_cq_ref'] for d in merge['drafts']} == set(local)
             and all(set(row['origin_cq_refs']) <= set(local) for row in merge['mapping']),
             'PG_CQ_PARTIAL_ORIGIN_INVALID')
    questions = [('LOCAL', q) for q in local.values()] + [('AGGREGATE', q) for q in merge['cq_input']['items']]
    signatures = [(plan, 'plan_sha256', 'PG_CQ_PLAN_SHA_CHANGED')] + [(r, 'record_sha256', 'PG_CQ_SIGNED_RECORD_CHANGED') for r in [merge, *drafts]]
    values = [{k: v for k, v in r.items() if k != key} for r, key, _ in signatures]
    hashes = hasher.many(values)
    for value, (r, key, error) in zip(hashes, signatures):
        need(value == r.get(key), error)
    ranges = []
    for kind, item in questions:
        need(text_field(item.get('question')), 'PG_CQ_QUESTION_INVALID')
        for field, range_kind in [('ranges', 'EXACT'), ('fallback_ranges', 'FALLBACK')]:
            for ordinal, r in enumerate(item.get(field, [])):
                row = dict(kind=kind, cq_ref=item['cq_ref'], range_kind=range_kind, ordinal=ordinal, range=clone(r), error=None)
                try:
                    range_units(plan, r, hasher)
                except CQError as exc:
                    row['error'] = exc.code
                ranges.append(row)
    envelope = dict(run_id=run_id, source_snapshot_ref=plan['source_snapshot_ref'], plan=clone(plan))
    envelope['record_sha256'] = hasher.digest(envelope)
    artifact_ids = sorted([dict(name=a['name'], role=a['role'], sha256=sha(a['bytes'])) for a in artifacts], key=lambda a: a['name'])
    content_sha = sha(dump(dict(contract='pg-cq-python-archive/1', archive_id=archive_id, artifacts=artifact_ids)))
    return dict(plan=plan, result=result, snapshot=snapshot, run_id=run_id, merge=merge, blocks=blocks, block_map=block_map,
                docs=docs, drafts=drafts, questions=questions, ranges=ranges, content_sha=content_sha, envelope=envelope)


def load_material(view, cq_ref, hasher=DEFAULT_HASHER):
    item = next((q for q in view['merge']['cq_input']['items'] if q['cq_ref'] == cq_ref), None)
    need(item is not None, 'NATIVE_CQ_REF_UNKNOWN')
    invalid = next((r for r in view['ranges'] if r['kind'] == 'AGGREGATE' and r['cq_ref'] == cq_ref and r['error']), None)
    if invalid:
        raise CQError(invalid['error'])
    return {**load_range_materials(view['plan'], item, hasher), 'item': clone(item)}
