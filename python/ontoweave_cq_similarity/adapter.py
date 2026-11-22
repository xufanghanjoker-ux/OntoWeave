"""Consume the authenticated CQ provider view; retain frozen range records."""
from copy import deepcopy
from .core import digest, require, POLICY, validate_input
from ontoweave_cq5000.pg_contract import load_material
from ontoweave_cq5000.ranges import load_range_materials


def from_archive(archive, library_ref, space):
    v = archive['view']
    require(v['snapshot']['library_id']==library_ref,'LIBRARY_MISMATCH')
    # prepare_archive/read_archive has authenticated legacy signatures and projections.
    aggregate = v['merge'].get('cq_input')
    require(isinstance(aggregate, dict) and isinstance(aggregate.get('items'), list), 'AUTHORITATIVE_AGGREGATE_REQUIRED')
    items = []; manifest = {}
    for source in aggregate['items']:
        cq = source['cq_ref']; ranges = []
        rows = [r for r in v['ranges'] if r['kind']=='AGGREGATE' and r['cq_ref']==cq]
        require(rows and all(not r['error'] for r in rows), 'FROZEN_RANGE_INVALID')
        # Existing loader is the only range interpreter, including fallback.
        load_material(v, cq)
        for row in rows:
            frozen = dict(range_kind=row['range_kind'], range=deepcopy(row['range']))
            ref = 'range_' + digest(frozen)
            record = manifest.setdefault(ref, dict(cq_refs=[], frozen_range_ref='frozen_'+digest(frozen), frozen_range=frozen, frozen_range_sha256=digest(frozen)))
            record['cq_refs'].append(cq); ranges.append(ref)
        items.append(dict(cq_ref=cq, question=source['question'], range_refs=sorted(set(ranges)),
                          origin_cq_refs=[q['cq_ref'] for q in source.get('local_questions', [])] or [cq], source_item=deepcopy(source)))
    for r in manifest.values(): r['cq_refs'] = sorted(set(r['cq_refs']))
    blocks = [dict(doc_ref=b['doc_ref'],revision=b['revision'],chunk_ref=b['chunk_ref'],cq_refs=sorted(i['cq_ref'] for i in items if any(manifest[r]['frozen_range']['range']['chunk_ref']==b['chunk_ref'] for r in i['range_refs']))) for b in v['blocks']]
    data = dict(schema_version='cq-similarity-input/1',library_ref=library_ref,source_snapshot_ref=v['snapshot']['snapshot_id'],
                cq_input_ref=aggregate['input_ref'], archive_id=archive['input']['archive_id'], archive_content_sha256=v['content_sha'],
                range_manifest_ref='ranges_'+digest(manifest),range_manifest=manifest,embedding_space=deepcopy(space),policy=deepcopy(POLICY),items=items,block_manifest=blocks,
                adopted_view='AGGREGATE_CQ_INPUT_WITH_LOCAL_ORIGINS')
    validate_input(data)
    return data


def load_group_materials(view, data, group):
    """Proof/readback entry, not downstream task execution. Loader dedups unit_ref."""
    validate_input(data)
    require(view['content_sha']==data['archive_content_sha256'] and view['snapshot']['snapshot_id']==data['source_snapshot_ref'], 'SOURCE_CHANGED')
    items = {i['cq_ref']:i for i in data['items']}
    require(all(c in items for c in group['cq_refs']), 'GROUP_CQ_UNKNOWN')
    expected = sorted({r for c in group['cq_refs'] for r in items[c]['range_refs']})
    require(expected == group['range_refs'], 'GROUP_RANGE_CHANGED')
    union = dict(ranges=[],fallback_ranges=[],range_status='UNIT_RANGES')
    for ref in expected:
        row = data['range_manifest'][ref]['frozen_range']
        union['ranges' if row['range_kind']=='EXACT' else 'fallback_ranges'].append(row['range'])
        if row['range_kind']=='FALLBACK': union['range_status']='BLOCK_FALLBACK_PRESENT'
    return load_range_materials(view['plan'],union)


def load_plan_materials(view, data, groups):
    """Readback proof: one source-unit registry, group/CQ membership kept apart."""
    refs=[c for g in groups for c in g['cq_refs']]
    require(len(refs)==len(set(refs)) and set(refs)=={i['cq_ref'] for i in data['items']},'PLAN_CQ_COVERAGE_INVALID')
    # Validate each group's original range union before loading the total union once.
    items={i['cq_ref']:i for i in data['items']}
    for g in groups:
        require(g['range_refs']==sorted({r for c in g['cq_refs'] for r in items[c]['range_refs']}),'GROUP_RANGE_CHANGED')
    allgroup=dict(cq_refs=sorted(refs),range_refs=sorted({r for g in groups for r in g['range_refs']}))
    loaded=load_group_materials(view,data,allgroup)
    def key(u): return digest({k:u[k] for k in ('doc_ref','revision','chunk_ref','unit_ref')})
    units={key(u):u for u in loaded['units']}
    memberships=[]
    for g in groups:
        selected=set()
        for ref in g['range_refs']:
            r=data['range_manifest'][ref]['frozen_range']['range']
            for uref in r['unit_refs']:
                selected.add(digest(dict(doc_ref=r['doc_ref'],revision=r['revision'],chunk_ref=r['chunk_ref'],unit_ref=uref)))
        require(selected<=units.keys(),'UNIT_REGISTRY_MISSING')
        memberships.append(dict(group_ref=g['group_ref'],cq_refs=g['cq_refs'],range_refs=g['range_refs'],unit_keys=sorted(selected)))
    return dict(contract=loaded['contract'],units=units,groups=memberships,unique_units_loaded=len(units),range_precision='FROZEN_UNIT_NO_PROMOTION')
