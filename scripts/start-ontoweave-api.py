#!/usr/bin/env python3
"""Run the local PG API against explicitly registered databases."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from hashlib import sha256, shake_256
import json
import os
from pathlib import Path
import sys
from threading import Event, Thread
from urllib.parse import urlsplit

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from ontoweave_api.app import create_app, export_openapi
from ontoweave_api.builds import BuildPort
from ontoweave_api.directory import WorkspaceDirectory
from ontoweave_cq.store import PGCQStore
from ontoweave_facts.repository import apply_fact_bundle
from ontoweave_facts.rust_adapter import RustEngine
from ontoweave_identity.publication import activate_for_publisher
from ontoweave_index import RetrievalReader, embedding_space, migrate as migrate_index
from ontoweave_index.publication import PublicationIndex
from ontoweave_index.settings import index_settings, query_reranker
from ontoweave_publication.coordinator import Publisher
from ontoweave_publication.decisions import Decisions
from ontoweave_publication.domains import DecisionPlanner, DOMAINS, stage_domains
from ontoweave_publication.integration import WorldTimeFilter
from ontoweave_publication.runtime import isolated_pg, verify_pg
from ontoweave_publication.readers import Reader
from ontoweave_publication.store import digest, head, require
from ontoweave_product.registry import WorkspaceRegistry, migrate_registry, require_active
from ontoweave_query_sessions import QuerySessionStore, migrate as migrate_query_sessions


def apply_waiting(directory, stop):
    while not stop.wait(.3):
        try:
            stores = {}
            for library in directory.names():
                backend = directory.get(library)
                if backend["applies_human_jobs"]:
                    stores.setdefault(backend["store"], []).append(library)
            for store, libraries in stores.items():
                with store.transaction(readonly=True) as (q, _):
                    row = q("""SELECT d.library_ref,d.job_ref FROM publication_v1.decisions d
                               JOIN publication_v1.jobs j USING (library_ref,job_ref)
                               WHERE d.library_ref=ANY(%s) AND j.status IN ('QUEUED','RUNNING')
                               ORDER BY j.created_at,j.job_ref LIMIT 1""", [libraries]).fetchone()
                if row:
                    selected = directory.get(row["library_ref"])
                    selected["decisions"].process(selected["publisher"], row["library_ref"], row["job_ref"])
        except Exception as error:
            print("Local application job:", getattr(error,"code",type(error).__name__), file=sys.stderr)


class SimulatedRetrievalEmbedding:
    space = embedding_space(provider_identity="NATIVE_SIM", endpoint_identity="LOCAL",
                            model="synthetic-retrieval/1", dimensions=32,
                            configuration_fingerprint=digest("synthetic-retrieval/1"))

    def embed(self, texts, *, library_ref, profile_ref, operation_ref):
        vectors = [[(byte - 127.5) / 128 for byte in shake_256(text.encode()).digest(32)] for text in texts]
        return dict(vectors=vectors, receipt=dict(actual_requests=0, simulated_inputs=len(texts), usage_status="SIMULATED"))


def review_capabilities(config, library):
    domains = library.get("review_domains", config.get("review_domains", ["FACT"]))
    require(isinstance(domains, list) and all(isinstance(domain, str) and domain in DOMAINS for domain in domains)
            and len(domains) == len(set(domains)), "REVIEW_DOMAIN_REGISTRY_INVALID")
    enabled = library.get("apply_human_jobs", config.get("apply_human_jobs", False))
    require(type(enabled) is bool, "HUMAN_JOB_WORKER_CONFIG_INVALID")
    return domains, enabled


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--export-openapi", action="store_true")
    args = parser.parse_args()
    if args.export_openapi:
        print(json.dumps(export_openapi(), ensure_ascii=False, indent=2))
        return
    require(args.config, "EXPLICIT_PG_REGISTRY_REQUIRED")
    config = json.loads(args.config.read_bytes())
    token = os.environ.get("ONTOWEAVE_PG_WRITE_TOKEN")
    require(token and len(token) >= 32 and config.get("actor_ref"), "TRUSTED_ACTOR_CONFIG_REQUIRED")
    endpoint = urlsplit(config["api_origin"])
    require(endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
            and not endpoint.path.strip("/") and not endpoint.query and not endpoint.fragment
            and endpoint.port and 1024 <= endpoint.port <= 65535, "API_PORT_INVALID")
    product_mode = config.get("mode") == "PRODUCT_PG"
    if product_mode:
        mode = config.get("runtime_mode")
        require(mode in {"REAL", "NATIVE_SIM"} and config.get("real_generation") is (mode == "REAL")
                and config.get("real_embedding") is (mode == "REAL"),
                "PRODUCT_PG_API_CONFIG_REQUIRED")
        from ontoweave_product.runtime import ProductRuntime
        from ontoweave_product.builds import ProductReader
    else:
        require(config.get("mode") in {"OFFLINE","SAVED_PG"} and config.get("real_generation") is False
                and config.get("real_embedding") is False and config.get("runtime_mode","OFF") == "OFF",
                "SAVED_PG_API_CONFIG_REQUIRED")
    binary = Path(config["rust_binary"]).resolve(strict=True)
    require(sha256(binary.read_bytes()).hexdigest() == config["rust_sha256"], "RUST_BINARY_CHANGED")
    engine = RustEngine(binary)
    model_settings = None
    if config.get("model_settings_enabled") is True:
        from ontoweave_product.models import ProductModelSettings

        require(product_mode and config.get("unified_workbench_v2") is True,
                "MODEL_SETTINGS_REQUIRES_MANAGED_WORKBENCH")
        model_settings = ProductModelSettings(os.environ.get("ONTOWEAVE_PRODUCT_CREDENTIAL_FILE"), mode)
    segment_codepoints, embedding_client = index_settings(
        config.get("retrieval_index"), credential_resolver=model_settings.credential if model_settings and mode == "REAL" else None)
    query = config.get("query")
    if query:
        from ontoweave_query import QueryKernel, QueryRegistry, QueryService

    static = config.get("libraries", [])
    names = [row["library_ref"] for row in static]
    default = config.get("default_library_ref")
    require(all(names) and len(set(names)) == len(names) and (default is None or default in names)
            and all(row["backend"] == "PG" and isinstance(row.get("title"), str) for row in static),
            "LIBRARY_REGISTRY_INVALID")
    dynamic = config.get("workspace_registry")
    unified = config.get("unified_workbench_v2") is True
    require(dynamic is None or (product_mode and isinstance(dynamic, dict) and set(dynamic) == {"connection_file"}),
            "WORKSPACE_REGISTRY_CONFIG_INVALID")
    require(static or dynamic, "LIBRARY_REGISTRY_INVALID")
    if unified:
        domains, writes = review_capabilities(config, {})
        require(dynamic and query and segment_codepoints is not None and writes and domains,
                "UNIFIED_WORKBENCH_PORTS_REQUIRED")
        require(query["mode"] == mode, "PRODUCT_QUERY_MODE_MISMATCH")
        if mode == "REAL":
            require(embedding_client is not None, "PRODUCT_RETRIEVAL_EMBEDDING_REQUIRED")
        elif embedding_client is None:
            embedding_client = SimulatedRetrievalEmbedding()

    stores = {}
    stop = Event()
    product = managed = None
    if product_mode:
        paths = {Path(row["connection_file"]).resolve() for row in static}
        if dynamic:
            paths.add(Path(dynamic["connection_file"]).resolve())
        require(len(paths) == 1, "PRODUCT_REGISTRY_REQUIRES_ONE_PG_DATABASE")
        db_path = next(iter(paths))
        settings = isolated_pg(db_path)
        store = PGCQStore(settings)
        stores[db_path] = store
        product = ProductRuntime(config, store, db_path, settings, stop, model_settings)
        product.prepare(names)
        if dynamic:
            migrate_registry(store)
            managed = WorkspaceRegistry(store)
            store.workspace_write_guard = require_active
        if unified:
            product.verify_query_model(query, embedding_client, config["retrieval_index"].get("embedding"))

    kernel = QueryKernel(binary, config["rust_sha256"]) if query else None
    models = dict(generation=dict(configured=bool(product or query), model="qwen3.8-flash" if product or query else None),
                  embedding=dict(configured=embedding_client is not None,
                                 model=embedding_client.space["model"] if embedding_client else None,
                                 dimensions=embedding_client.space["dimensions"] if embedding_client else None),
                  reranker=dict(configured=bool(query and query.get("reranker")),
                                model=(query or {}).get("reranker", {}).get("model")))

    if model_settings:
        model_settings.store = product.store
        model_settings.models = models
        product.store.product_model_settings = model_settings

    def factory(row):
        library = row["library_ref"]
        connection = row.get("connection_file") or dynamic["connection_file"]
        path = Path(connection).resolve(strict=True)
        settings = isolated_pg(path)
        domains, apply_human_jobs = review_capabilities(config, row)
        if path not in stores:
            stores[path] = PGCQStore(settings)
        store = stores[path]
        with store.transaction(readonly=True) as (q, _):
            verify_pg(q, settings)
            head(q, library)
        if path not in prepared_stores:
            if config.get("retrieval_index") is not None or query:
                migrate_index(store)
            if segment_codepoints is not None:
                store.retrieval_preparer = PublicationIndex(store, client=embedding_client,
                                                           segment_codepoints=segment_codepoints)
            prepared_stores.add(path)
        publisher = Publisher(store, apply_fact_bundle, activate_identity=activate_for_publisher,
                              stage_domains=stage_domains)
        planner = DecisionPlanner(store, engine, enabled=domains)
        reader_options = dict(world_time_filter=WorldTimeFilter(store, engine), review_domains=domains,
                              runs_human_jobs=apply_human_jobs, query_registered=bool(query), models=models)
        reader = (ProductReader(store, product.builds, product.mode, creation_registered=managed is not None,
                                **reader_options) if product else Reader(store, **reader_options))
        decisions = Decisions(store, planner, review_reader=reader)
        backend = dict(reader=reader, decisions=decisions, build=product.builds if product else BuildPort(store),
                       applies_human_jobs=apply_human_jobs, publisher=publisher, store=store)
        if query:
            def authorized(requested, actor_scope):
                return requested == library and actor_scope == config["actor_ref"] and directory.get(requested) is not None

            repository_reader = RetrievalReader(store, authorize=authorized, world_time_filter=reader.world_time_filter,
                                               certified_descriptors=query.get("certified_descriptors", {}).get(library))
            backend["retrieval"] = repository_reader
            backend["query"] = QueryRegistry(QueryService(repository_reader, kernel, embedding_client=embedding_client,
                                                            rerank=query_reranker(store, library, query.get("reranker"))))
        return backend

    prepared_stores = set()

    def ports_available():
        return product.worker_available() and (not config.get("apply_human_jobs") or human_worker.is_alive())

    directory = WorkspaceDirectory(static, default, factory=factory, registration=managed,
                                   can_create=ports_available if managed else None)
    human_worker = Thread(target=apply_waiting, args=(directory, stop), name="human-publication", daemon=True)
    for library in directory.names():
        directory.get(library)
    if product_mode and not prepared_stores:
        if config.get("retrieval_index") is not None or query:
            migrate_index(store)
        if segment_codepoints is not None:
            store.retrieval_preparer = PublicationIndex(store, client=embedding_client,
                                                       segment_codepoints=segment_codepoints)
        prepared_stores.add(db_path)
    sessions = None
    if query:
        session_database = product.store if product else directory.get(default or names[0])["store"]
        migrate_query_sessions(session_database)
        sessions = QuerySessionStore(session_database)
    app = create_app({}, actor=config["actor_ref"], write_token=token, directory=directory,
                     model_settings=model_settings, query_sessions=sessions)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            if product:
                product.start(directory.names, engine)
            human_worker.start()
            yield
        finally:
            stop.set()
            if product:
                await asyncio.to_thread(product.close)
            if human_worker.ident is not None:
                human_worker.join(timeout=5)
            for store in stores.values():
                store.close()

    app.router.lifespan_context = lifespan
    uvicorn.run(app, host="127.0.0.1", port=endpoint.port, access_log=False)


if __name__ == "__main__":
    main()
