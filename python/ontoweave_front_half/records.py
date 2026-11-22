"""Live adapter for the CQ record port, using the existing PG transaction/pool."""
import threading
from contextlib import contextmanager
from pathlib import Path
from psycopg.types.json import Jsonb
from ontoweave_cq.store import sha
from ontoweave_cq_similarity.core import digest, require

ROOT=Path(__file__).resolve().parents[2]
class PGRecords:
    def __init__(self,store,run_id):
        self.store,self.run_id=store,run_id
        self.local=threading.local()
        self.metrics=[]
    def migrate(self):
        sql=(ROOT/'migrations/003-front-half-run.sql').read_bytes(); pin=sha(sql)
        with self.store.transaction() as (q,m):
            q("SELECT pg_advisory_xact_lock(hashtext('front-half-schema-v1'))")
            exists=q("SELECT to_regclass('front_half.schema_version') AS t").fetchone()['t']
            if exists:
                require(q('SELECT sha256 FROM front_half.schema_version WHERE version=1').fetchone()['sha256']==pin,'FRONT_HALF_MIGRATION_CHANGED')
            else:
                q(sql.decode());q('INSERT INTO front_half.schema_version VALUES(1,%s)',[pin])
            q('INSERT INTO front_half.runs(run_id) VALUES(%s) ON CONFLICT DO NOTHING',[self.run_id])
        self.metrics.append(m)
    @contextmanager
    def transaction(self):
        if getattr(self.local,'q',None):
            yield self
            return
        with self.store.transaction() as (q,m):
            q('SELECT pg_advisory_xact_lock(hashtext(%s))',['front-half:'+self.run_id])
            self.local.q=q
            try: yield self
            finally: self.local.q=None
        self.metrics.append(m)
    def get_record(self,kind,key):
        with self.transaction():
            row=self.local.q('SELECT payload,payload_sha FROM front_half.records WHERE run_id=%s AND kind=%s AND key=%s',[self.run_id,kind,key]).fetchone()
            if row is None:return None
            require(digest(row['payload'])==row['payload_sha'],'LIVE_RECORD_SHA_CHANGED')
            return row['payload']
    def put_record(self,kind,key,value):
        with self.transaction():
            args=[self.run_id,kind,key,Jsonb(value),digest(value)]
            self.local.q('INSERT INTO front_half.records(run_id,kind,key,payload,payload_sha) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(run_id,kind,key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha=EXCLUDED.payload_sha,updated_at=clock_timestamp()',args)
            self.local.q('INSERT INTO front_half.history(run_id,kind,key,payload,payload_sha) VALUES(%s,%s,%s,%s,%s)',args)
        return value
    def list_rows(self):
        with self.transaction():
            rows=self.local.q('SELECT kind,key,payload,payload_sha FROM front_half.records WHERE run_id=%s ORDER BY kind,key',[self.run_id]).fetchall()
            require(all(digest(r['payload'])==r['payload_sha'] for r in rows),'LIVE_RECORD_SHA_CHANGED')
            return rows
    def batch(self, rows):
        """Preserve every history entry and apply the final value of repeated keys atomically."""
        require(isinstance(rows, list) and len(rows) <= 4096, 'LIVE_RECORD_BATCH_INVALID')
        if not rows:
            return
        encoded = []
        current = {}
        for row in rows:
            kind, key, payload = row['kind'], row['key'], row['payload']
            require(isinstance(kind, str) and kind and isinstance(key, str) and key,
                    'LIVE_RECORD_BATCH_KEY_INVALID')
            value = dict(kind=kind, key=key, payload=payload, payload_sha=digest(payload))
            encoded.append(value)
            current[kind, key] = value
        with self.transaction():
            self.local.q(
                """INSERT INTO front_half.records(run_id,kind,key,payload,payload_sha)
                   SELECT %s,r.kind,r.key,r.payload,r.payload_sha
                   FROM jsonb_to_recordset(%s::jsonb) AS r(kind text,key text,payload jsonb,payload_sha text)
                   ON CONFLICT(run_id,kind,key) DO UPDATE SET
                     payload=EXCLUDED.payload,payload_sha=EXCLUDED.payload_sha,updated_at=clock_timestamp()""",
                [self.run_id, Jsonb(list(current.values()))],
            )
            self.local.q(
                """INSERT INTO front_half.history(run_id,kind,key,payload,payload_sha)
                   SELECT %s,r.value->>'kind',r.value->>'key',r.value->'payload',r.value->>'payload_sha'
                   FROM jsonb_array_elements(%s::jsonb) WITH ORDINALITY AS r(value,ordinal)
                   ORDER BY r.ordinal""",
                [self.run_id, Jsonb(encoded)],
            )

class PGLedger:
    def __init__(self,repo,key):self.repo,self.key=repo,key
    def reserve(self,metadata):
        with self.repo.transaction():
            require(self.repo.get_record('embedding_request',self.key) is None,'EMBEDDING_NO_AUTOMATIC_REPLAY')
            self.repo.put_record('embedding_request',self.key,dict(status='STARTED',**metadata))
    def settle(self,status,**fields):
        with self.repo.transaction():
            old=self.repo.get_record('embedding_request',self.key)
            require(old and old['status']=='STARTED','EMBEDDING_SETTLEMENT_CONFLICT')
            self.repo.put_record('embedding_request',self.key,{**old,'status':status,**fields})
