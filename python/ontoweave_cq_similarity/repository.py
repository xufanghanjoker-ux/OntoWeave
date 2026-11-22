"""Additive PG cache, immutable bindings and plans, exact pgvector readback."""
import json
from pathlib import Path
from psycopg.types.json import Jsonb
from .core import digest, canonical, require, space_ref, input_sha, vector

ROOT = Path(__file__).resolve().parents[2]


class SimilarityRepository:
    def __init__(self, cq_store): self.store = cq_store

    def migrate(self):
        sql = (ROOT/'migrations/002-cq-similarity.sql').read_text()
        sha = digest(sql)
        with self.store.transaction() as (q, metrics):
            q("SELECT pg_advisory_xact_lock(hashtext('cq-similarity-schema-v1'))")
            exists = q("SELECT to_regclass('cq_similarity.schema_version') AS table_name").fetchone()['table_name']
            if exists:
                old = q('SELECT sha256 FROM cq_similarity.schema_version WHERE version=1').fetchone()
                require(old and old['sha256']==sha, 'SIMILARITY_MIGRATION_CHANGED')
            else:
                q(sql); q('INSERT INTO cq_similarity.schema_version VALUES(1,%s)', [sha])
        return dict(reused=bool(exists), timings=metrics)

    def cache_get(self, library, space, text_sha):
        sr = space_ref(space)
        with self.store.transaction(readonly=True) as (q, _):
            row = q('SELECT c.*,s.identity FROM cq_similarity.cache c JOIN cq_similarity.spaces s USING(space_ref) WHERE library_ref=%s AND space_ref=%s AND input_sha=%s', [library,sr,text_sha]).fetchone()
        if row is None: return None
        require(row['identity']==space and digest(row['values_json'])==row['vector_sha'], 'CACHE_INTEGRITY_FAILED')
        vector(row['values_json'],space['dimensions'])
        return row['values_json']

    def save_vectors(self, data, vectors, receipt):
        sr = space_ref(data['embedding_space'])
        require(set(vectors)=={i['cq_ref'] for i in data['items']}, 'VECTOR_COVERAGE_INVALID')
        with self.store.transaction() as (q, metrics):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))', [data['library_ref']+sr])
            q('INSERT INTO cq_similarity.spaces VALUES(%s,%s) ON CONFLICT DO NOTHING', [sr,Jsonb(data['embedding_space'])])
            require(q('SELECT identity FROM cq_similarity.spaces WHERE space_ref=%s',[sr]).fetchone()['identity']==data['embedding_space'], 'SPACE_CONFLICT')
            for item in data['items']:
                val = vector(vectors[item['cq_ref']],data['embedding_space']['dimensions']); ts=input_sha(item['question'])
                key=[data['library_ref'],sr,ts]
                q('INSERT INTO cq_similarity.cache VALUES(%s,%s,%s,%s,%s::vector,%s,%s) ON CONFLICT DO NOTHING', [*key,Jsonb(val),canonical(val),digest(val),Jsonb(receipt)])
                old=q('SELECT vector_sha FROM cq_similarity.cache WHERE library_ref=%s AND space_ref=%s AND input_sha=%s',key).fetchone()
                require(old['vector_sha']==digest(val),'CACHE_IMMUTABLE_CONFLICT')
                q('INSERT INTO cq_similarity.bindings VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING', [data['library_ref'],data['source_snapshot_ref'],item['cq_ref'],sr,ts])
                old=q('SELECT input_sha FROM cq_similarity.bindings WHERE library_ref=%s AND snapshot_ref=%s AND cq_ref=%s AND space_ref=%s',[data['library_ref'],data['source_snapshot_ref'],item['cq_ref'],sr]).fetchone()
                require(old['input_sha']==ts,'BINDING_IMMUTABLE_CONFLICT')
        return metrics

    def exact_pairs(self, data):
        sr=space_ref(data['embedding_space']); refs=sorted(i['cq_ref'] for i in data['items'])
        with self.store.transaction(readonly=True) as (q, metrics):
            rows=q('''WITH scoped AS (
              SELECT b.cq_ref,c.embedding FROM cq_similarity.bindings b
              JOIN cq_similarity.cache c USING(library_ref,space_ref,input_sha)
              WHERE b.library_ref=%s AND b.snapshot_ref=%s AND b.space_ref=%s AND b.cq_ref=ANY(%s))
              SELECT a.cq_ref AS left_cq_ref,b.cq_ref AS right_cq_ref,
              1-(a.embedding <=> b.embedding) AS cosine_similarity FROM scoped a JOIN scoped b ON a.cq_ref<b.cq_ref
              ORDER BY a.cq_ref,b.cq_ref''',[data['library_ref'],data['source_snapshot_ref'],sr,refs]).fetchall()
        require(len(rows)==len(refs)*(len(refs)-1)//2,'PG_PAIR_COVERAGE_INVALID')
        return rows,metrics

    def save_plan(self, plan):
        with self.store.transaction() as (q, metrics):
            q('INSERT INTO cq_similarity.plans VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',[plan['plan_ref'],plan['input_sha256'],Jsonb(plan),digest(plan)])
            row=q('SELECT * FROM cq_similarity.plans WHERE plan_ref=%s',[plan['plan_ref']]).fetchone()
            require(row['payload_sha']==digest(plan) and digest(row['payload'])==row['payload_sha'],'PLAN_IMMUTABLE_CONFLICT')
        return metrics

    def read_plan(self, ref):
        with self.store.transaction(readonly=True) as (q,_): row=q('SELECT * FROM cq_similarity.plans WHERE plan_ref=%s',[ref]).fetchone()
        require(row and digest(row['payload'])==row['payload_sha'],'PLAN_MISSING_OR_CHANGED')
        return row['payload']
