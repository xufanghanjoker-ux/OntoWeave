"""Configuration and a PostgreSQL-backed worker for the first-upload product."""

import json
import os
from pathlib import Path
import re
import sys
from threading import Thread

import psycopg
from psycopg.errors import FeatureNotSupported, InsufficientPrivilege, UndefinedFile

from ontoweave_cq.store import CQStoreError
from ontoweave_cq_similarity.embedding import public_space
from ontoweave_cq_similarity.repository import SimilarityRepository
from ontoweave_extraction import V3_POLICY_VERSION
from ontoweave_extraction.repository import Reception
from ontoweave_facts.repository import apply_fact_bundle, migrate as migrate_facts
from ontoweave_front_half.baselines import verify_baseline
from ontoweave_identity.publication import activate_for_publisher
from ontoweave_identity.storage import migrate as migrate_identity
from ontoweave_ontology.repository import OntologyRepository
from ontoweave_publication.coordinator import Publisher
from ontoweave_publication.runtime import load_runtime, verify_pg
from ontoweave_publication.store import migrate, require

from .builds import ProductBuilds, migrate_upload
from .pipeline import Progress, _reason, execute_product

REAL_EMBEDDING = {
    "protocol": "dashscope-native", "endpoint_mode": "full",
    "base_url": "https://cn-beijing.maas.qianwenaiapi.com/api/v1/services/embeddings/text-embedding/text-embedding",
    "model": "qwen3.7-text-embedding-flash", "dimensions": 1024,
}
WORKER_LOCK = (6559341, 1)
SIM_EMBEDDING = {
    "protocol": "openai-compatible", "endpoint_mode": "full", "base_url": "https://sim.invalid/embeddings",
    "model": "product-upload-v1-synthetic", "dimensions": 32,
}


def enable_pgvector(store):
    try:
        with store.transaction() as (q, _):
            q("CREATE EXTENSION IF NOT EXISTS vector")
    except InsufficientPrivilege:
        require(False, "PGVECTOR_EXTENSION_PERMISSION_REQUIRED", 503)
    except (FeatureNotSupported, UndefinedFile):
        require(False, "PGVECTOR_EXTENSION_NOT_INSTALLED", 503)


class ProductPublisher(Publisher):
    def __init__(self, store, guard):
        self.guard = guard

        def activate(q, library, body, activated_at):
            guard(q)
            return activate_for_publisher(q, library, body, activated_at)

        super().__init__(store, apply_fact_bundle, activate_identity=activate)

    def _step(self, library, job, name, input_sha, work):
        def fenced(q, info):
            self.guard(q)
            return work(q, info)

        return super()._step(library, job, name, input_sha, fenced)

    def _stage(self, *args):
        self.guard()
        return super()._stage(*args)


class ProductRuntime:
    def __init__(self, config, store, pg_path, pg, stop, model_settings=None):
        self.store = store
        self.pg_path = pg_path
        self.pg = pg
        self.stop = stop
        self.config = config["product"]
        self.mode = config["runtime_mode"]
        self.model_settings = model_settings
        self.concurrency = self.config["concurrency"]
        require(type(self.concurrency) is int and 1 <= self.concurrency <= 4, "PRODUCT_CONCURRENCY_INVALID")
        self.parser = Path(self.config["parser_python"]).absolute()
        require(self.parser.is_file() and os.access(self.parser, os.X_OK), "PRODUCT_PARSER_UNAVAILABLE")
        self.run_root = Path(self.config["run_root"]).resolve()
        self.run_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        require(not self.run_root.stat().st_mode & 0o077, "PRODUCT_ARTIFACT_DIRECTORY_NOT_PRIVATE")
        self.runtime_file = Path(self.config["native_runtime_file"]).resolve(strict=True)
        self.credential_path = None
        self.scenarios = {}
        self.default_scenario = {}
        self.embedding = self.config["embedding"]
        if self.mode == "REAL":
            require(self.embedding == REAL_EMBEDDING and "simulation_file" not in self.config,
                    "PRODUCT_REAL_RUNTIME_INVALID")
            path = os.environ.get("ONTOWEAVE_PRODUCT_CREDENTIAL_FILE")
            require(path, "PRODUCT_CREDENTIAL_FILE_REQUIRED")
            self.credential_path = Path(path)
        else:
            require(self.embedding == SIM_EMBEDDING, "PRODUCT_SIM_EMBEDDING_CONFIGURATION_INVALID")
            if self.config.get("simulation_file"):
                scenario = json.loads(Path(self.config["simulation_file"]).read_bytes())
                self.scenarios = scenario["libraries"]
                self.default_scenario = scenario.get("default_library", {})
        public_space(self.embedding)
        verify_baseline()
        if model_settings:
            _, _, public = load_runtime(self.runtime_file, self.run_root, credential_file=self.credential_path,
                                        configuration_only=True)
            require(public["concurrency"] == self.concurrency, "PRODUCT_NATIVE_RUNTIME_MISMATCH")
        else:
            _, _, public, _ = self.runtime("", self.run_root)
        self.native_binding = public["runtime_binding"]
        self.builds = ProductBuilds(store)
        self.builds.worker_available = lambda: self.worker_available() and self.credentials_ready()
        self.builds.managed_models = model_settings is not None
        self.connection = None
        self.session_identity = None
        self.worker = None
        self.current = None
        self.store.product_dispatch_guard = self.assert_owned
        self.publisher = ProductPublisher(store, self.assert_owned)

    def runtime(self, library, output):
        mode, runtime, public = load_runtime(self.runtime_file, output / "ontology",
                                             credential_file=self.credential_path)
        require(mode == self.mode and runtime.concurrency == self.concurrency, "PRODUCT_NATIVE_RUNTIME_MISMATCH")
        scenario = self.scenarios.get(library, self.default_scenario)
        if mode == "NATIVE_SIM":
            runtime.simulation = scenario.get("ontology", {})
        configuration = dict(runtime_binding=runtime.config["runtime_binding"],
                             models=dict(generation=public["registry_generation"], embedding=self.embedding))
        return mode, runtime, configuration, scenario

    def verify_query_model(self, query, embedding_client, embedding_settings):
        raw = json.loads(self.runtime_file.read_bytes())
        generation = raw["models"]["generation"]
        profile = query["generation"]
        require(all(profile.get(key) == generation.get(key) for key in ("model", "reasoning_effort")),
                "PRODUCT_QUERY_GENERATION_MISMATCH")
        binding = query["native_runtime_binding"]
        require(Path(binding["lock_file"]).resolve() == Path(self.native_binding["lock_file"]).resolve()
                and binding["lock_sha256"] == self.native_binding["lock_sha256"], "PRODUCT_QUERY_RUNTIME_LOCK_MISMATCH")
        if self.mode != "REAL":
            return
        joined_key = os.environ.get("ONTOWEAVE_QUERY_CREDENTIAL_FILE") or self.credential_path
        require(profile["base_url"] == generation["base_url"]
                and Path(joined_key).resolve() == self.credential_path.resolve(), "PRODUCT_QUERY_PROVIDER_MISMATCH")
        reference = (embedding_settings or {}).get("credential_file_env")
        embedding_key = os.environ.get(reference) if reference else None
        require(embedding_client.url == self.embedding["base_url"] and embedding_client.protocol == self.embedding["protocol"]
                and all(embedding_client.space[key] == self.embedding[key] for key in ("model", "dimensions"))
                and embedding_key and Path(embedding_key).resolve() == self.credential_path.resolve(),
                "PRODUCT_RETRIEVAL_EMBEDDING_MISMATCH")

    def verify_target(self):
        name = self.pg["database"]
        allowed = (name == "ontoweave_publication_product_real" if self.mode == "REAL"
                   else re.fullmatch(r"ontoweave_publication_product_sim(?:_[a-z0-9_]{1,20})?", name))
        require(allowed, "PRODUCT_ISOLATED_DATABASE_REQUIRED")
        with self.store.transaction(readonly=True) as (q, _):
            verify_pg(q, self.pg)
            row = q("""SELECT system_identifier::text AS system_id, current_setting('data_directory') AS directory
                       FROM pg_control_system()""").fetchone()
        require(row["system_id"] == self.config["cluster_system_id"]
                and Path(row["directory"]).resolve() == Path(self.config["pg_data_directory"]).resolve(strict=True),
                "PRODUCT_PG_CLUSTER_CHANGED")

    def acquire(self):
        settings = dict(self.pg)
        settings["dbname"] = settings.pop("database")
        settings.pop("max", None)
        self.connection = psycopg.connect(**settings, autocommit=True)
        try:
            locked = self.connection.execute("SELECT pg_try_advisory_lock(%s,%s)", WORKER_LOCK).fetchone()[0]
            require(locked, "PRODUCT_WORKER_ALREADY_ACTIVE")
            self.session_identity = self.connection.execute(
                "SELECT pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()"
            ).fetchone()
        except BaseException:
            self.connection.close()
            self.connection = None
            raise

    def assert_owned(self, q=None):
        if q is None:
            with self.store.transaction() as (query, _):
                return self.assert_owned(query)
        if self.stop.is_set() or not self.current or self.session_identity is None:
            raise CQStoreError("PRODUCT_WORKER_FENCED")
        library, run = self.current
        lock = q("""SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid)
                    WHERE l.pid=%s AND a.backend_start=%s AND l.locktype='advisory' AND l.granted
                      AND l.classid=%s AND l.objid=%s AND l.objsubid=2""",
                 [*self.session_identity, *WORKER_LOCK]).fetchone()
        build = q("""SELECT body->>'execution_status' AS status FROM publication_v1.builds
                     WHERE library_ref=%s AND run_ref=%s FOR SHARE""", [library, run]).fetchone()
        if self.stop.is_set() or not lock or not build or build["status"] != "RUNNING":
            raise CQStoreError("PRODUCT_WORKER_FENCED")

    def prepare(self, libraries):
        self.verify_target()
        self.acquire()
        enable_pgvector(self.store)
        self.store.migrate()
        SimilarityRepository(self.store).migrate()
        Reception(self.store, V3_POLICY_VERSION).migrate()
        migrate_identity(self.store)
        OntologyRepository(self.store).migrate()
        migrate_facts(self.store)
        migrate(self.store)
        migrate_upload(self.store)
        for library in libraries:
            self.publisher.register(library)

    def credentials_ready(self):
        return self.model_settings is None or self.model_settings.ready()

    def worker_available(self):
        return not self.stop.is_set() and self.worker is not None and self.worker.is_alive()

    def start(self, libraries, engine):
        list_libraries = libraries if callable(libraries) else lambda: libraries
        self.builds.settle_interrupted(list_libraries())
        self.worker = Thread(target=self._work, args=(list_libraries, engine), name="product-upload", daemon=True)
        self.worker.start()

    def close(self):
        if self.worker:
            self.worker.join()
        if self.connection:
            self.connection.close()

    def _work(self, libraries, engine):
        while not self.stop.wait(.2):
            try:
                # Losing the session releases its advisory lock. Stop this worker immediately.
                self.connection.execute("SELECT 1")
            except psycopg.Error as error:
                print("Product worker lock:", _reason(error), file=sys.stderr)
                return
            if not self.credentials_ready():
                continue
            try:
                upload = self.builds.claim(libraries())
            except Exception as error:
                print("Product upload claim:", _reason(error), file=sys.stderr)
                continue
            if upload:
                self.current = upload["library_ref"], upload["run_ref"]
                progress = Progress(self.builds, *self.current, self.assert_owned)
                try:
                    execute_product(self, progress, self.publisher, engine)
                except Exception as error:
                    try:
                        if not self.builds.settle_confirmed(progress.library, progress.run):
                            try:
                                self.assert_owned()
                            except CQStoreError as fenced:
                                error = fenced
                            progress.stop(error)
                    except Exception as settlement_error:
                        print("Product build settlement:", _reason(settlement_error), file=sys.stderr)
                    print("Product build:", progress.run, progress.current, _reason(error), file=sys.stderr)
                finally:
                    self.current = None
