"""Question-only exact recall and bounded task grouping. No model semantics."""
import hashlib
import json
import math

POLICY = dict(similarity_threshold=0.85, top_k=4, max_cqs_per_group=5,
              search_mode='EXACT', grouping='BOUNDED_ANCHOR_V1', embedding_batch_size=20, embedding_concurrency=2)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(ok, code):
    if not ok:
        raise ValueError(code)


def normalize(question):
    require(isinstance(question, str) and bool(question.strip()), 'QUESTION_INVALID')
    return ' '.join(question.split())


def input_sha(question):
    return hashlib.sha256(normalize(question).encode()).hexdigest()


def space_ref(space):
    fields = ('provider', 'model', 'deployment', 'revision', 'dimensions', 'normalization', 'input_version')
    require(isinstance(space, dict) and all(space.get(k) for k in fields), 'SPACE_INCOMPLETE')
    require(type(space['dimensions']) is int and 0 < space['dimensions'] <= 65536, 'SPACE_DIMENSION_INVALID')
    require(space['normalization'] == 'NONE' and space['input_version'] == 'cq-question-only/1', 'SPACE_UNSUPPORTED')
    return 'space_' + digest(space)


def vector(values, dimensions):
    require(isinstance(values, list) and len(values) == dimensions, 'VECTOR_DIMENSION_INVALID')
    require(all(type(x) in (int, float) and math.isfinite(x) for x in values), 'VECTOR_NONFINITE')
    norm = math.hypot(*values)
    require(math.isfinite(norm) and norm > 0, 'VECTOR_ZERO_OR_OVERFLOW')
    return values


def cosine(a, b):
    vector(a, len(b)); vector(b, len(a))
    na, nb = math.hypot(*a), math.hypot(*b)
    return max(-1.0, min(1.0, math.fsum((x / na) * (y / nb) for x, y in zip(a, b))))


def validate_input(data):
    require(data['schema_version'] == 'cq-similarity-input/1', 'INPUT_VERSION_INVALID')
    for k in ('library_ref', 'source_snapshot_ref', 'cq_input_ref', 'range_manifest_ref'):
        require(isinstance(data[k], str) and data[k], 'INPUT_BINDING_REQUIRED')
    items = data['items']; refs = {i['cq_ref'] for i in items}
    require(len(refs) == len(items), 'DUPLICATE_CQ')
    require(data['range_manifest_ref'] == 'ranges_' + digest(data['range_manifest']), 'RANGE_MANIFEST_CHANGED')
    for i in items:
        normalize(i['question'])
        require(i['range_refs'] and i['origin_cq_refs'], 'CQ_SOURCE_REQUIRED')
        require(all(r in data['range_manifest'] and i['cq_ref'] in data['range_manifest'][r]['cq_refs'] for r in i['range_refs']), 'CQ_RANGE_MISSING')
    block_refs = [r for b in data['block_manifest'] for r in b['cq_refs']]
    require(set(block_refs) == refs, 'BLOCK_CQ_COVERAGE_INVALID')
    p = data['policy']
    require(p['search_mode'] == 'EXACT' and p['grouping'] == 'BOUNDED_ANCHOR_V1', 'POLICY_UNSUPPORTED')
    require(type(p['top_k']) is int and p['top_k'] > 0 and type(p['max_cqs_per_group']) is int and p['max_cqs_per_group'] >= 2, 'POLICY_LIMIT_INVALID')
    require(type(p['similarity_threshold']) in (int, float) and math.isfinite(p['similarity_threshold']) and -1 <= p['similarity_threshold'] <= 1, 'THRESHOLD_INVALID')
    if items:
        space_ref(data['embedding_space'])


def group_scores(refs, scores, policy):
    """Frozen score matrix in; no rounding before threshold or ordering."""
    refs = sorted(refs)
    require(len(refs) == len(set(refs)), 'DUPLICATE_CQ')
    expected = {(a,b) for n,a in enumerate(refs) for b in refs[n+1:]}
    require(set(scores) == expected and all(math.isfinite(s) and -1 <= s <= 1 for s in scores.values()), 'SCORES_INVALID')
    def score(a,b): return scores[tuple(sorted((a,b)))]
    neighbors = {a: sorted((b for b in refs if b != a), key=lambda b: (-score(a,b), b))[:policy['top_k']] for a in refs}
    candidates = {tuple(sorted((a,b))) for a in refs for b in neighbors[a] if score(a,b) >= policy['similarity_threshold']}
    remaining = set(refs); groups = []; limits = set()
    while remaining:
        near = {a: sorted((b for b in remaining if b != a and tuple(sorted((a,b))) in candidates), key=lambda b: (-score(a,b), b)) for a in remaining}
        anchor = min(remaining, key=lambda a: (-len(near[a]), -max((score(a,b) for b in near[a]), default=-2), a))
        chosen = [anchor] + near[anchor][:policy['max_cqs_per_group']-1]
        limits.update(tuple(sorted((anchor,b))) for b in near[anchor][policy['max_cqs_per_group']-1:])
        groups.append(dict(anchor_cq_ref=anchor, cq_refs=chosen, mode='RELATED' if len(chosen)>1 else 'LOCAL',
                           pair_evidence=[dict(left_cq_ref=min(anchor,b), right_cq_ref=max(anchor,b), cosine_similarity=score(anchor,b)) for b in chosen[1:]]))
        remaining.difference_update(chosen)
    membership = {cq:n for n,g in enumerate(groups) for cq in g['cq_refs']}
    diagnostics = [dict(left_cq_ref=a,right_cq_ref=b,cosine_similarity=scores[(a,b)],
                        reason='SAME_GROUP' if membership[a]==membership[b] else 'GROUP_LIMIT' if (a,b) in limits else 'CANDIDATE_ALREADY_ASSIGNED',
                        group_indices=[membership[a],membership[b]]) for a,b in sorted(candidates)]
    return groups, diagnostics


def build_plan(data, vectors):
    validate_input(data)
    items = {i['cq_ref']:i for i in data['items']}; refs = sorted(items)
    require(set(vectors) == set(refs), 'VECTOR_COVERAGE_INVALID')
    for v in vectors.values(): vector(v, data['embedding_space']['dimensions'])
    scores = {(a,b):cosine(vectors[a],vectors[b]) for n,a in enumerate(refs) for b in refs[n+1:]}
    groups, diagnostics = group_scores(refs, scores, data['policy'])
    for g in groups:
        g['range_refs'] = sorted({r for cq in g['cq_refs'] for r in items[cq]['range_refs']})
        g['group_ref'] = 'group_' + digest(g)
    plan = {k:data[k] for k in ('library_ref','source_snapshot_ref','cq_input_ref','range_manifest_ref','range_manifest','embedding_space','policy','items')}
    plan.update(schema_version='cq-similarity-plan/1', input_sha256=digest(data), groups=groups, diagnostics=diagnostics,
                skipped_blocks=[{**b,'reason':'SKIPPED_NO_CQ'} for b in data['block_manifest'] if not b['cq_refs']], warnings=[],
                pairs=[dict(left_cq_ref=a,right_cq_ref=b,cosine_similarity=s) for (a,b),s in scores.items()], vector_sha256=digest(vectors))
    plan['plan_ref'] = 'plan_' + digest(plan)
    return plan
