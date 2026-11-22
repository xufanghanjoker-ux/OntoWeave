"""Offline original-proposal replay through Python, exporting the PG contract.

Preserves baseline artifacts byte-for-byte under separate roles. Python-created
result bytes are explicitly NEW projections; old record signatures stay intact.
"""
import json
from .compat import DEFAULT_HASHER, clone, dump, sha
from .pg_contract import prepare_archive, load_material
from .receiver import BlockReceiver, aggregate_drafts
from .repository import MemoryRecords
from .errors import need


def replay_archive(input, *, repo=None, hasher=DEFAULT_HASHER):
    baseline = prepare_archive(input, hasher)
    repo = repo if repo is not None else MemoryRecords()
    state = baseline['result']['chunked']
    drafts, comparisons = [], []
    for index, block in enumerate(baseline['blocks']):
        original = next(d for d in baseline['drafts'] if d['chunk_ref'] == block['chunk_ref'])
        receiver = BlockReceiver(repo=repo, run_id=baseline['run_id'], snapshot_id=baseline['snapshot']['snapshot_id'], binding=state['binding'],
                                 plan=baseline['plan'], block=block, index=index, hasher=hasher)
        receipt = receiver.call('lightog_save_cq_list', original['raw_proposal'])
        need(receipt.get('ok') and receiver.saved is not None, 'CQ_PYTHON_REPLAY_SAVE_FAILED')
        drafts.append(receiver.saved)
        comparisons.append(dict(kind='DRAFT_FULL_RECORD', chunk_ref=block['chunk_ref'], equal=receiver.saved == original,
                                baseline_record_sha256=original['record_sha256'], replay_record_sha256=receiver.saved['record_sha256']))
    merge = aggregate_drafts(run_id=baseline['run_id'], snapshot_id=baseline['snapshot']['snapshot_id'], binding=state['binding'],
                             plan=baseline['plan'], drafts=drafts, hasher=hasher)
    comparisons.append(dict(kind='MERGE_FULL_RECORD', equal=merge == baseline['merge'],
                            baseline_record_sha256=baseline['merge']['record_sha256'], replay_record_sha256=merge['record_sha256']))
    result = dict(run_id=baseline['run_id'], execution_mode='PYTHON_FROZEN_PROPOSAL_REPLAY_NO_MODEL',
                  chunked=dict(binding=state['binding'], merge=merge, chunks=[dict(chunk_ref=d['chunk_ref'], draft=d) for d in drafts]))
    artifacts = []
    for artifact in input['artifacts']:
        if artifact['role'] == 'result':
            artifacts.append(dict(name='baseline-result.json', role='baseline-result', bytes=artifact['bytes']))
        else:
            artifacts.append(clone(artifact))
    artifacts.append(dict(name='python-replayed-result.json', role='result', bytes=dump(result).encode('utf-8')))
    replayed_input = dict(archive_id='cq-python-replay-' + baseline['run_id'], artifacts=artifacts)
    replayed = prepare_archive(replayed_input, hasher)
    expected = {a['role'][9:]:json.loads(a['bytes'])['material'] for a in input['artifacts'] if a['role'].startswith('readback:')}
    for q in merge['cq_input']['items']:
        actual, old = load_material(replayed, q['cq_ref'], hasher), load_material(baseline, q['cq_ref'], hasher)
        comparisons.append(dict(kind='MATERIAL_FULL_JSON_AND_TEXT', cq_ref=q['cq_ref'], equal=actual == old and (q['cq_ref'] not in expected or actual == expected[q['cq_ref']]),
                                text_sha256=sha(actual['text']), baseline_text_sha256=sha(old['text'])))
    return dict(input=replayed_input, view=replayed, comparison=dict(equal=all(c['equal'] for c in comparisons), checks=comparisons,
                real_model_requests=0, execution='OFFLINE_REPLAY', original_result_bytes_preserved=True))
