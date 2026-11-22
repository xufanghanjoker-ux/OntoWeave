"""Python CQ business storage; Psycopg 3 is the sole active PG writer.

Original bytes and legacy SHA fields are preserved. The small read-only Node hash
bridge authenticates the existing JS canonical contract; Python never substitutes
its JSON serialization for a historical signature. Coordinates are frozen unit
identities, not Python, UTF-16, or byte offsets.
"""
from __future__ import annotations
import copy
import hashlib
import json
import time
from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = 'CQ_UNIT_RANGES_V1'
KINDS = {'plan': 'native_chunked_cq_plan_v1', 'merge': 'native_cq_chunk_merge_v1', 'draft': 'native_cq_chunk_draft_v1'}
TABLES = ('documents', 'versions', 'blocks', 'units', 'questions', 'members', 'ranges', 'range_units', 'records', 'artifacts')


class CQStoreError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(ok, code):
    if not ok:
        raise CQStoreError(code)


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else bytes(value)).hexdigest()


def dump(value):
    """Python projection serialization only; NEVER an old JS byte/signature claim."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def same_projection(a, b):
    """JSON value comparison for PG integrity, never a legacy signature codec.

    Python considers True == 1. Keep JSON booleans distinct from numbers while
    allowing PostgreSQL JSONB's ordinary number representation equivalence.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if a is None or b is None:
        return a is b
    if isinstance(a, dict) or isinstance(b, dict):
        return isinstance(a, dict) and isinstance(b, dict) and a.keys() == b.keys() and all(same_projection(a[k], b[k]) for k in a)
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(same_projection(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def read_bundle(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_bytes())
    artifacts = []
    for item in manifest['artifacts']:
        data = (path.parent / item['path']).read_bytes()
        require(not item.get('sha256') or sha(data) == item['sha256'], 'PG_CQ_BUNDLE_SHA_CHANGED')
        artifacts.append({'name': item['name'], 'role': item['role'], 'bytes': data})
    return {'archive_id': manifest['archive_id'], 'artifacts': artifacts}


def inspect_archive(input):
    """CQ-owned preparation: legacy checks, reference/range rules and material contract."""
    from ontoweave_cq5000.pg_contract import prepare_archive
    return prepare_archive(input)


def load_material(view, cq_ref):
    from ontoweave_cq5000.pg_contract import load_material as cq_load_material
    return cq_load_material(view, cq_ref)


class PGCQStore:
    def __init__(self, config):
        settings = dict(config)
        settings['dbname'] = settings.pop('database', settings.get('dbname', 'ontoweave_cq_acceptance'))
        max_size = settings.pop('max', 4)
        settings.setdefault('connect_timeout', 5)
        settings['row_factory'] = dict_row
        self.pool = ConnectionPool(kwargs=settings, min_size=1, max_size=max_size, max_waiting=16, timeout=10, open=False)
        self.pool.open(wait=True)

    def close(self):
        self.pool.close()

    @contextmanager
    def transaction(self, readonly=False):
        started = time.perf_counter()
        metrics = dict(sql_ms=0.0, sql_calls=0)
        with self.pool.connection() as conn:
            with conn.transaction():
                def q(sql, args=None):
                    start = time.perf_counter()
                    try:
                        return conn.execute(sql, args, prepare=False)
                    finally:
                        metrics['sql_ms'] += (time.perf_counter() - start) * 1000
                        metrics['sql_calls'] += 1
                if readonly:
                    q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                yield q, metrics
        metrics['transaction_ms'] = (time.perf_counter() - started) * 1000

    def migrate(self):
        data = (ROOT / 'migrations/001-pg-cq.sql').read_bytes()
        with self.transaction() as (q, metrics):
            q("SELECT pg_advisory_xact_lock(hashtext('pg-cq-schema-v1'))")
            q('CREATE TABLE IF NOT EXISTS pg_cq_schema_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
            old = q('SELECT sha256 FROM pg_cq_schema_migrations WHERE version=1').fetchone()
            if old:
                require(old['sha256'] == sha(data), 'PG_CQ_MIGRATION_CHANGED')
            else:
                q(data.decode('utf-8'))
                q('INSERT INTO pg_cq_schema_migrations VALUES(1,%s)', [sha(data)])
        return dict(reused=bool(old), timings=metrics)

    def save_archive(self, input):
        started = time.perf_counter()
        v, archive_id = inspect_archive(input), input['archive_id']
        with self.transaction() as (q, metrics):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))', [archive_id])
            old = q('SELECT content_sha256 FROM pg_cq_archives WHERE archive_id=%s', [archive_id]).fetchone()
            if old:
                require(old['content_sha256'] == v['content_sha'], 'PG_CQ_IMMUTABLE_CONFLICT')
                receipt = dict(archive_id=archive_id, reused=True, content_sha256=v['content_sha'])
            else:
                def insert(table, values):
                    require(table in (*TABLES, 'archives'), 'PG_CQ_INTERNAL_TABLE_INVALID')
                    return q('INSERT INTO pg_cq_' + table + ' VALUES (' + ','.join(['%s'] * len(values)) + ')', values)
                q('INSERT INTO pg_cq_archives(archive_id,run_id,content_sha256) VALUES(%s,%s,%s)', [archive_id, v['run_id'], v['content_sha']])
                for a in input['artifacts']:
                    insert('artifacts', [archive_id, a['name'], a['role'], a['bytes'], sha(a['bytes'])])
                for d in v['docs']:
                    insert('documents', [archive_id, d['doc_id'], d.get('title', '')])
                    original = next((a for a in input['artifacts'] if a['role'] == 'original:' + d['doc_id']), None)
                    insert('versions', [archive_id, d['doc_id'], d['revision'], d['content'], sha(d['content']), sha(original['bytes']) if original else None, dump(d)])
                for b in v['blocks']:
                    insert('blocks', [archive_id, b['chunk_ref'], b['doc_ref'], b['revision'], v['plan']['plan_ref'], b['manifest_ref'], b['contextualized_text'], sha(b['contextualized_text']), b['token_count'], dump(b)])
                    for i, u in enumerate(b['units']):
                        insert('units', [archive_id, b['chunk_ref'], u['unit_ref'], u['label'], u.get('ordinal', i), u['text'], u['text_sha256'], u.get('context', ''), dump(u.get('source_items', [])), u.get('fragment'), dump(u)])
                for kind, item in v['questions']:
                    insert('questions', [archive_id, kind, item['cq_ref'], item['question'], item.get('range_status', 'LEGACY_BLOCK_ONLY'), dump(item)])
                for a, local in _members(v):
                    require(any(kind == 'LOCAL' and item['cq_ref'] == local for kind, item in v['questions']), 'PG_CQ_MEMBER_MISSING')
                    insert('members', [archive_id, a, local, 'AGGREGATE', 'LOCAL'])
                for row in v['ranges']:
                    r, valid = row['range'], not row['error']
                    r = r if isinstance(r, dict) else {}
                    refs = r.get('unit_refs', [])
                    insert('ranges', [archive_id, row['kind'], row['cq_ref'], row['range_kind'], row['ordinal'], r['chunk_ref'] if valid else None, r.get('start'), r.get('end'), refs[0] if valid else None, refs[-1] if valid else None, 'VALID' if valid else 'QUARANTINED', row['error'], dump(row['range'])])
                    if valid:
                        for i, ref in enumerate(refs):
                            insert('range_units', [archive_id, row['kind'], row['cq_ref'], row['range_kind'], row['ordinal'], i, r['chunk_ref'], ref])
                records = [(KINDS['plan'], v['run_id'], v['envelope']), (KINDS['merge'], v['run_id'], v['merge'])]
                records += [(KINDS['draft'], v['run_id'] + ':' + d['chunk_ref'], d) for d in v['drafts']]
                for kind, key, record in records:
                    insert('records', [archive_id, kind, key, dump(record), record['record_sha256']])
                receipt = dict(archive_id=archive_id, reused=False, content_sha256=v['content_sha'], quarantined_ranges=[dict(kind=r['kind'], cq_ref=r['cq_ref'], error=r['error']) for r in v['ranges'] if r['error']])
        metrics['business_ms'] = (time.perf_counter() - started) * 1000
        return {**receipt, 'timings': metrics}

    def read_archive(self, archive_id):
        started = time.perf_counter()
        with self.transaction(readonly=True) as (q, metrics):
            archive = q('SELECT * FROM pg_cq_archives WHERE archive_id=%s', [archive_id]).fetchone()
            require(archive, 'PG_CQ_ARCHIVE_UNKNOWN')
            rows = q('SELECT * FROM pg_cq_artifacts WHERE archive_id=%s ORDER BY name', [archive_id]).fetchall()
            artifacts = []
            for a in rows:
                require(sha(a['bytes']) == a['bytes_sha256'], 'PG_CQ_ARTIFACT_CHANGED')
                artifacts.append(dict(name=a['name'], role=a['role'], bytes=bytes(a['bytes'])))
            input = dict(archive_id=archive_id, artifacts=artifacts)
            v = inspect_archive(input)
            require(archive['content_sha256'] == v['content_sha'] and archive['run_id'] == v['run_id'], 'PG_CQ_ARCHIVE_CHANGED')
            self._hydrate(q, archive_id, v, artifacts)
        metrics['business_ms'] = (time.perf_counter() - started) * 1000
        return dict(input=input, view=v, timings=metrics)

    def _hydrate(self, q, archive_id, v, artifacts):
        def rows(table):
            return q('SELECT * FROM pg_cq_' + table + ' WHERE archive_id=%s', [archive_id]).fetchall()
        docs, versions, blocks, units, questions = (rows(t) for t in ('documents', 'versions', 'blocks', 'units', 'questions'))
        require(len(docs) == len(versions) == len(v['docs']), 'PG_CQ_VERSION_PROJECTION_CHANGED')
        for d in v['docs']:
            doc = next((x for x in docs if x['doc_ref'] == d['doc_id']), None)
            r = next((x for x in versions if x['doc_ref'] == d['doc_id'] and x['revision'] == d['revision']), None)
            original = next((a for a in artifacts if a['role'] == 'original:' + d['doc_id']), None)
            require(doc and doc['title'] == d.get('title', '') and r and r['content'] == d['content'] and r['content_sha256'] == sha(d['content']) and r['original_sha256'] == (sha(original['bytes']) if original else None) and same_projection(json.loads(r['source_payload']), d), 'PG_CQ_VERSION_PROJECTION_CHANGED')
        require(len(blocks) == len(v['blocks']) and len(units) == sum(len(b['units']) for b in v['blocks']), 'PG_CQ_PROJECTION_CHANGED')
        hydrated = []
        for b in v['blocks']:
            r = next((x for x in blocks if x['chunk_ref'] == b['chunk_ref']), None)
            require(r is not None and sha(r['material']) == r['material_sha256'], 'PG_CQ_BLOCK_PROJECTION_CHANGED')
            block = json.loads(r['payload'])
            for key in ('chunk_ref', 'doc_ref', 'revision', 'plan_ref', 'manifest_ref', 'token_count'):
                block[key] = r[key]
            block['contextualized_text'] = r['material']
            block['units'] = []
            for i, u in enumerate(sorted((u for u in units if u['chunk_ref'] == b['chunk_ref']), key=lambda u: u['ordinal'])):
                unit = json.loads(u['payload'])
                require(unit.get('ordinal', i) == u['ordinal'], 'PG_CQ_UNIT_PROJECTION_CHANGED')
                for key in ('unit_ref', 'label', 'text', 'text_sha256', 'context', 'source_items'):
                    unit[key] = u[key]
                if 'fragment' in unit:
                    unit['fragment'] = u['fragment']
                block['units'].append(unit)
            require(same_projection(block, b), 'PG_CQ_BLOCK_PROJECTION_CHANGED')
            hydrated.append(block)
        require(len(questions) == len(v['questions']), 'PG_CQ_QUESTION_PROJECTION_CHANGED')
        for kind, item in v['questions']:
            r = next((x for x in questions if x['kind'] == kind and x['cq_ref'] == item['cq_ref']), None)
            require(r and same_projection(json.loads(r['payload']), item) and r['question'] == item['question'] and r['range_status'] == item.get('range_status', 'LEGACY_BLOCK_ONLY'), 'PG_CQ_QUESTION_PROJECTION_CHANGED')
        ranges, range_units = rows('ranges'), rows('range_units')
        require(len(ranges) == len(v['ranges']) and len(range_units) == sum(len(r['range']['unit_refs']) for r in v['ranges'] if not r['error']), 'PG_CQ_RANGE_PROJECTION_CHANGED')
        for expected in v['ranges']:
            r = next((x for x in ranges if x['question_kind'] == expected['kind'] and x['cq_ref'] == expected['cq_ref'] and x['range_kind'] == expected['range_kind'] and x['ordinal'] == expected['ordinal']), None)
            source = expected['range'] if isinstance(expected['range'], dict) else {}
            require(r and same_projection(json.loads(r['payload']), expected['range']) and r['validation_status'] == ('QUARANTINED' if expected['error'] else 'VALID') and r['validation_error'] == expected['error'] and r['start_label'] == source.get('start') and r['end_label'] == source.get('end'), 'PG_CQ_RANGE_PROJECTION_CHANGED')
            if not expected['error']:
                selected = sorted((u for u in range_units if u['question_kind'] == r['question_kind'] and u['cq_ref'] == r['cq_ref'] and u['range_kind'] == r['range_kind'] and u['range_ordinal'] == r['ordinal']), key=lambda u: u['unit_ordinal'])
                require(r['chunk_ref'] == source['chunk_ref'] and r['start_unit_ref'] == source['unit_refs'][0] and r['end_unit_ref'] == source['unit_refs'][-1] and [u['unit_ref'] for u in selected] == source['unit_refs'] and all(u['chunk_ref'] == r['chunk_ref'] for u in selected), 'PG_CQ_RANGE_PROJECTION_CHANGED')
        members = sorted((r['aggregate_ref'], r['local_ref']) for r in rows('members'))
        require(members == sorted(_members(v)), 'PG_CQ_MEMBER_PROJECTION_CHANGED')
        expected_records = {(KINDS['plan'], v['run_id']): v['envelope'], (KINDS['merge'], v['run_id']): v['merge']}
        expected_records.update({(KINDS['draft'], v['run_id'] + ':' + d['chunk_ref']): d for d in v['drafts']})
        records = rows('records')
        require(len(records) == len(expected_records), 'PG_CQ_RECORD_PROJECTION_CHANGED')
        for r in records:
            record = json.loads(r['payload'])
            require(same_projection(record, expected_records.get((r['kind'], r['record_key']))) and record['record_sha256'] == r['record_sha256'], 'PG_CQ_RECORD_PROJECTION_CHANGED')
        # Range reading now uses material and unit columns actually read from PG.
        v['blocks'], v['block_map'] = hydrated, {b['chunk_ref']: b for b in hydrated}
        v['plan']['windows' if 'windows' in v['plan'] else 'chunks'] = hydrated
        v['merge']['cq_input']['items'] = [json.loads(next(r['payload'] for r in questions if r['kind'] == 'AGGREGATE' and r['cq_ref'] == item['cq_ref'])) for item in v['merge']['cq_input']['items']]

    def read_cq(self, archive_id, cq_ref):
        started = time.perf_counter()
        archive = self.read_archive(archive_id)
        material = load_material(archive['view'], cq_ref)
        return dict(material=material, timings={**archive['timings'], 'business_ms': (time.perf_counter() - started) * 1000})

    def counts(self, archive_id):
        with self.transaction(readonly=True) as (q, metrics):
            counts = {t: q('SELECT count(*) AS n FROM pg_cq_' + t + ' WHERE archive_id=%s', [archive_id]).fetchone()['n'] for t in TABLES}
            states = q('SELECT kind,range_status,count(*) AS n FROM pg_cq_questions WHERE archive_id=%s GROUP BY kind,range_status', [archive_id]).fetchall()
            ranges = q('SELECT validation_status,count(*) AS n FROM pg_cq_ranges WHERE archive_id=%s GROUP BY validation_status', [archive_id]).fetchall()
        return dict(counts=counts, question_states=states, range_states=ranges, timings=metrics)


def _members(v):
    return list(dict.fromkeys((q['cq_ref'], local['cq_ref']) for q in v['merge']['cq_input']['items'] for local in q.get('local_questions', [])))
