"""Single owner for frozen-unit range business semantics; no file offsets."""
from .compat import DEFAULT_HASHER, clone, distinct, normalized_question, sha
from .errors import need

CONTRACT = 'CQ_UNIT_RANGES_V1'


def work_blocks(plan):
    return plan.get('windows') if plan.get('windows') is not None else plan['chunks']


def make_range(block, units, hasher=DEFAULT_HASHER):
    hashes = hasher.many([units, [u['text'] for u in units], [u.get('context') for u in units]])
    return dict(contract=CONTRACT, plan_ref=block['plan_ref'], manifest_ref=block['manifest_ref'],
                doc_ref=block['doc_ref'], revision=block['revision'], chunk_ref=block['chunk_ref'],
                material_sha256=sha(block['contextualized_text']), start=units[0]['label'], end=units[-1]['label'],
                unit_refs=[u['unit_ref'] for u in units], units_sha256=hashes[0], selected_text_sha256=hashes[1], context_sha256=hashes[2])


def resolve_unit_ranges(block, proposed, hasher=DEFAULT_HASHER):
    need(isinstance(block.get('units'), list) and len(block['units']) > 0 and block.get('manifest_ref'), 'CQ_UNIT_MANIFEST_REQUIRED')
    warnings, selected, bad = [], set(), False
    labels = [u['label'] for u in block['units']]
    if not isinstance(proposed, list) or not proposed:
        warnings.append({'code': 'CQ_RANGE_MISSING_BLOCK_FALLBACK'})
        bad = True
    else:
        for index, r in enumerate(proposed):
            start = labels.index(r.get('start')) if isinstance(r, dict) and r.get('start') in labels else -1
            end = labels.index(r.get('end')) if isinstance(r, dict) and r.get('end') in labels else -1
            if start < 0 or end < start or not isinstance(r, dict) or any(k not in ('start', 'end') for k in r):
                warnings.append({'code': 'CQ_RANGE_INVALID_BLOCK_FALLBACK', 'index': index})
                bad = True
                continue
            selected.update(range(start, end + 1))
    groups = []
    for index in sorted(selected):
        if not groups or index != groups[-1][-1] + 1:
            groups.append([])
        groups[-1].append(index)
    ranges = [make_range(block, [block['units'][i] for i in group], hasher) for group in groups]
    return dict(ranges=ranges, range_status=('PARTIAL_BLOCK_FALLBACK' if ranges else 'BLOCK_FALLBACK') if bad else 'UNIT_RANGES',
                fallback_ranges=[make_range(block, block['units'], hasher)] if bad else [], range_warnings=warnings)


def range_units(plan, r, hasher=DEFAULT_HASHER):
    need(isinstance(r, dict), 'CQ_RANGE_FROZEN_SOURCE_MISMATCH')
    block = next((c for c in work_blocks(plan) if c['chunk_ref'] == r.get('chunk_ref')), None)
    need(block is not None and r.get('contract') == CONTRACT and r.get('plan_ref') == plan['plan_ref'] == block.get('plan_ref')
         and r.get('doc_ref') == block['doc_ref'] and r.get('revision') == block['revision']
         and r.get('manifest_ref') == block.get('manifest_ref') and r.get('material_sha256') == sha(block['contextualized_text']),
         'CQ_RANGE_FROZEN_SOURCE_MISMATCH')
    labels = [u['label'] for u in block['units']]
    start = labels.index(r.get('start')) if r.get('start') in labels else -1
    end = labels.index(r.get('end')) if r.get('end') in labels else -1
    units = block['units'][start:end + 1]
    need(start >= 0 and end >= start, 'CQ_RANGE_FROZEN_UNIT_MISMATCH')
    values = [[u['unit_ref'] for u in units], units, [u['text'] for u in units], [u.get('context') for u in units]]
    actual = hasher.many(values + [r.get('unit_refs')])
    need(actual[0] == actual[4] and actual[1] == r.get('units_sha256') and actual[2] == r.get('selected_text_sha256')
         and actual[3] == r.get('context_sha256') and all(sha(u['text']) == u['text_sha256'] for u in units),
         'CQ_RANGE_FROZEN_UNIT_MISMATCH')
    return block, units


def load_range_materials(plan, item, hasher=DEFAULT_HASHER):
    output = {}
    for r in distinct([*item.get('ranges', []), *item.get('fallback_ranges', [])], hasher):
        block, units = range_units(plan, r, hasher)
        for u in units:
            row = dict(doc_ref=block['doc_ref'], revision=block['revision'], chunk_ref=block['chunk_ref'],
                       unit_ref=u['unit_ref'], label=u['label'], text=u['text'])
            for key in ('context', 'source_items', 'fragment'):
                if key in u:
                    row[key] = clone(u[key])
            output[u['unit_ref']] = row
    units = list(output.values())
    text = '\n\n'.join(('[CONTEXT]\n' + u['context'] + '\n' if u.get('context') else '') + '[' + u['label'] + '] ' + u['text'] for u in units)
    return dict(contract=CONTRACT, range_status=item.get('range_status', 'LEGACY_BLOCK_ONLY'), units=units, text=text, answer_coverage='UNASSESSED')


def aggregate_range_items(origins, plan=None, hasher=DEFAULT_HASHER):
    def consolidate(key):
        rows = distinct([r for q in origins for r in q.get(key, [])], hasher)
        if plan is None:
            return rows
        groups = {}
        for r in rows:
            key = hasher.digest([r.get(k) for k in ('plan_ref', 'manifest_ref', 'doc_ref', 'revision', 'chunk_ref')])
            groups.setdefault(key, []).append(r)
        result = []
        for rs in groups.values():
            block = next((c for c in work_blocks(plan) if c['chunk_ref'] == rs[0]['chunk_ref']), None)
            need(block, 'CQ_RANGE_FROZEN_SOURCE_MISMATCH')
            load_range_materials(plan, {'ranges': rs}, hasher)
            result.extend(resolve_unit_ranges(block, [{'start': r['start'], 'end': r['end']} for r in rs], hasher)['ranges'])
        return result
    local = []
    for q in origins:
        if q.get('local_questions') is not None:
            local.extend(clone(q['local_questions']))
        else:
            row = dict(cq_ref=q['cq_ref'], question=q['question'], ranges=clone(q.get('ranges', [])), fallback_ranges=clone(q.get('fallback_ranges', [])))
            if 'range_status' in q:
                row['range_status'] = q['range_status']
            local.append(row)
    return dict(ranges=consolidate('ranges'), fallback_ranges=consolidate('fallback_ranges'),
                range_warnings=[clone(w) for q in origins for w in q.get('range_warnings', [])],
                range_status='BLOCK_FALLBACK_PRESENT' if any(q.get('range_status') != 'UNIT_RANGES' for q in origins) else 'UNIT_RANGES', local_questions=local)


def can_aggregate(a, b):
    if normalized_question(a['question']) != normalized_question(b['question']):
        return False
    if a.get('range_status') != 'UNIT_RANGES' or b.get('range_status') != 'UNIT_RANGES':
        return a['cq_ref'] == b['cq_ref']
    return any(x['doc_ref'] == y['doc_ref'] and x['revision'] == y['revision'] and
               (any(ref in y['unit_refs'] for ref in x['unit_refs']) or
                x.get('selected_text_sha256') == y.get('selected_text_sha256') and x.get('context_sha256') == y.get('context_sha256'))
               for x in a.get('ranges', []) for y in b.get('ranges', []))
