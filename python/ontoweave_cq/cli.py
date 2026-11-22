"""Dedicated opt-in Python CQ archive CLI. No HTTP or model runtime is started."""
import argparse
import json
import os
from pathlib import Path
import sys
from .store import PGCQStore, inspect_archive, read_bundle, sha, require


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def verify_bundle(store, bundle_path, report_path):
    input = read_bundle(bundle_path)
    v = inspect_archive(input)
    archive = store.read_archive(input['archive_id'])
    for a in input['artifacts']:
        read = next((x for x in archive['input']['artifacts'] if x['name'] == a['name']), None)
        require(read and read['bytes'] == a['bytes'], 'PG_CQ_INPUT_BYTE_MISMATCH')
    readback_dir = Path(report_path).resolve().parent / 'python-pg-readbacks'
    readback_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, item in enumerate(v['merge']['cq_input']['items']):
        loaded = store.read_cq(input['archive_id'], item['cq_ref'])
        expected = next((a for a in input['artifacts'] if a['role'] == 'readback:' + item['cq_ref']), None)
        require(expected is not None, 'PG_CQ_FROZEN_READBACK_REQUIRED')
        require(loaded['material'] == json.loads(expected['bytes'])['material'], 'PG_CQ_FROZEN_READBACK_MISMATCH')
        for u in loaded['material']['units']:
            b = next(b for b in v['blocks'] if b['chunk_ref'] == u['chunk_ref'])
            frozen = next(x for x in b['units'] if x['unit_ref'] == u['unit_ref'])
            require(u['text'] == frozen['text'] and sha(u['text']) == frozen['text_sha256'] and u['revision'] == b['revision'] and u['source_items'] == frozen['source_items'], 'PG_CQ_FROZEN_UNIT_MISMATCH')
        label = 'CQ' + str(i + 1).zfill(2)
        write_json(readback_dir / (label + '.json'), loaded['material'])
        (readback_dir / (label + '.txt')).write_bytes(loaded['material']['text'].encode('utf-8'))
        rows.append(dict(id=label, cq_ref=item['cq_ref'], question=item['question'], range_status=loaded['material']['range_status'], units=len(loaded['material']['units']), exact_match_to_frozen_readback=True, text_sha256=sha(loaded['material']['text']), timings=loaded['timings']))
    documents = []
    for d in v['docs']:
        original = next((a for a in input['artifacts'] if a['role'] == 'original:' + d['doc_id']), None)
        wrapped = next((a for a in input['artifacts'] if a['role'] == 'docling:' + d['doc_id']), None)
        source = next((s for s in v['plan'].get('sources', []) if s['doc_ref'] == d['doc_id']), None)
        if source and wrapped:
            require(sha(wrapped['bytes']) == source['raw_sha256'], 'PG_CQ_DOCLING_BYTE_MISMATCH')
        # This is an explicitly weaker relationship check, not exact original-file offsets.
        if original:
            # Use only the same ordinary whitespace present in these retained artifacts.
            import re
            require(re.sub(r'[\t\n\r\f\v ]', '', original['bytes'].decode('utf-8')) == re.sub(r'[\t\n\r\f\v ]', '', d['content']), 'PG_CQ_ORIGINAL_RELATIONSHIP_MISMATCH')
        documents.append(dict(doc_ref=d['doc_id'], revision=d['revision'], frozen_content_sha256=sha(d['content']), original_bytes_sha256=sha(original['bytes']) if original else None, original_equals_frozen_ignoring_ascii_whitespace=bool(original), docling_sha_preserved=bool(wrapped)))
    report = dict(status='PASS_PYTHON_REAL_PG_BUSINESS_READBACK', archive_id=input['archive_id'], source_run=v['run_id'], artifact_byte_checks=len(input['artifacts']), documents=documents, counts=store.counts(input['archive_id']), readbacks=rows, model_calls=0, embedding_calls=0, rerank_calls=0, precision='Frozen unit text; original Markdown bytes preserved separately. No character offset conversion.')
    write_json(report_path, report)
    return dict(status=report['status'], archive_id=input['archive_id'], cq=len(rows), artifact_byte_checks=len(input['artifacts']))


def vector_smoke(store):
    with store.transaction() as (q, metrics):
        q("CREATE TEMP TABLE pg_cq_synthetic_vectors(id text PRIMARY KEY,scope text NOT NULL,kind text NOT NULL CHECK(kind='SYNTHETIC_TEST_ONLY'),v vector(3)) ON COMMIT DROP")
        q("INSERT INTO pg_cq_synthetic_vectors VALUES ('same','accepted','SYNTHETIC_TEST_ONLY','[1,0,0]'),('orthogonal','accepted','SYNTHETIC_TEST_ONLY','[0,1,0]'),('opposite','accepted','SYNTHETIC_TEST_ONLY','[-1,0,0]'),('excluded','other','SYNTHETIC_TEST_ONLY','[1,0,0]')")
        rows = q('SELECT id,v::text,v <=> %s::vector AS distance FROM pg_cq_synthetic_vectors WHERE scope=%s ORDER BY distance,id', ['[1,0,0]', 'accepted']).fetchall()
        require([r['id'] for r in rows] == ['same', 'orthogonal', 'opposite'] and [r['distance'] for r in rows] == [0.0, 1.0, 2.0] and rows[0]['v'] == '[1,0,0]', 'PG_CQ_VECTOR_SMOKE_FAILED')
    return dict(kind='SYNTHETIC_TEST_ONLY', temporary_table=True, rows=rows, timings=metrics)


def server_info(store):
    with store.transaction(readonly=True) as (q, metrics):
        row = q("SELECT version(),current_database(),current_user,pg_postmaster_start_time()::text AS postmaster_started_at,current_setting('listen_addresses') AS listen_addresses,current_setting('port') AS port,(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector_version").fetchone()
    return {**row, 'timings': metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=os.environ.get('PG_CQ_CONFIG', 'local-runs/pg-cq-acceptance-v1/connection.json'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('migrate')
    p = sub.add_parser('import'); p.add_argument('bundle')
    p = sub.add_parser('read'); p.add_argument('archive'); p.add_argument('cq_ref')
    p = sub.add_parser('counts'); p.add_argument('archive')
    p = sub.add_parser('verify'); p.add_argument('bundle'); p.add_argument('report')
    sub.add_parser('info'); sub.add_parser('vector-smoke')
    args = parser.parse_args()
    store = None
    try:
        store = PGCQStore(json.loads(Path(args.config).read_bytes()))
        if args.command == 'migrate': result = store.migrate()
        elif args.command == 'import': result = store.save_archive(read_bundle(args.bundle))
        elif args.command == 'read': result = store.read_cq(args.archive, args.cq_ref)
        elif args.command == 'counts': result = store.counts(args.archive)
        elif args.command == 'verify': result = verify_bundle(store, args.bundle, args.report)
        elif args.command == 'info': result = server_info(store)
        else: result = vector_smoke(store)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(json.dumps({'error': getattr(exc, 'code', None) or getattr(exc, 'sqlstate', None) or type(exc).__name__}), file=sys.stderr)
        return 1
    finally:
        if store:
            store.close()
    return 0
