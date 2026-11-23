"""Exercise continued chat and gateway recovery on an isolated seeded PG database."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import os
from threading import Thread
from time import monotonic, sleep

from uvicorn import Config, Server

from ontoweave_api.app import create_app
from ontoweave_cq.store import PGCQStore
from ontoweave_facts.rust_adapter import RustEngine
from ontoweave_index import RetrievalReader
from ontoweave_publication.integration import WorldTimeFilter
from ontoweave_publication.runtime import isolated_pg, verify_pg
from ontoweave_query import QueryKernel, QueryRegistry, QueryService
from ontoweave_query_sessions import QuerySessionStore, migrate


def verify(args):
    config = isolated_pg(args.pg_config)
    assert config["host"].startswith("/private/tmp/ontoweave-pg-sessions.")
    store = PGCQStore(config)
    try:
        with store.transaction(readonly=True) as (q, _):
            verify_pg(q, config)
        migrate(store)
        with store.transaction(readonly=True) as (q, _):
            expected = q("SELECT * FROM query_sessions_v1.records ORDER BY kind,id").fetchall()
        library = args.library
        product = [row["payload"] for row in expected if row["kind"] == "native_query_product_v1"
                   and row["payload"]["library_id"] == library]
        assert len(product) == 1 and product[0]["status"] == "COMPLETED", "Seed one completed turn in PG before the test"
        actor, token = "offline-session-check","offline-session-test-token"
        engine = RustEngine(args.rust_binary)
        reader = RetrievalReader(store,authorize=lambda lib, scope: lib == library and scope == actor,
                                 world_time_filter=WorldTimeFilter(store,engine))
        for row in product:
            reader.load_index_descriptor({**row["input"]["source_scope"]["query_read_view"],
                                          "authorization_scope":actor})
        registry = QueryRegistry(QueryService(reader,QueryKernel(args.rust_binary,args.rust_sha256)))
        application = create_app({library:{"query":registry,"retrieval":reader}},actor=actor,
                                 write_token=token,query_sessions=QuerySessionStore(store))
        listener = socket.socket()
        listener.bind(("127.0.0.1",0))
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        server = Server(Config(application,log_level="error"))
        thread = Thread(target=server.run,kwargs={"sockets":[listener]},daemon=True)
        thread.start()
        try:
            end = monotonic()+5
            while not server.started and thread.is_alive() and monotonic() < end:
                sleep(.02)
            assert server.started
            subprocess.run(["node","tests/query_sessions/native.mjs"],check=True,env={
                **os.environ,"QUERY_TEST_API":origin,"QUERY_TEST_TOKEN":token,"QUERY_TEST_LIBRARY":library,
                "QUERY_TEST_RUNTIME":str(args.runtime),"QUERY_TEST_OUT":str(args.output),
            })
        finally:
            server.should_exit = True
            thread.join(5)
            listener.close()
        reopened = PGCQStore(config)
        try:
            with reopened.transaction(readonly=True) as (q, _):
                rows = q("SELECT * FROM query_sessions_v1.records ORDER BY kind,id").fetchall()
            rows_by_key = {(row["kind"],row["id"]):row for row in rows}
            for old in expected:
                kind,ref = old["kind"],old["id"]
                if kind in {"native_query_conversation_v1","source_model_config_revision"}:
                    continue
                assert rows_by_key[kind,ref] == old
            assert sum(row["kind"] == "native_query_product_v1" and row["payload"]["library_id"] == library
                       for row in rows) == len(product) + 3
        finally:
            reopened.close()
        return {"existing_record_readback_equal": True, "fresh_pg_read_after_gateway": True,
                "confirmed_view_verified": len(product),
                "new_simulated_turns":1,"synthetic_recovery_rows":2,"real_generation":0,"real_embedding":0}
    finally:
        store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, epilog="Seed one completed turn with a citation in a disposable PG workspace.")
    for key in ("pg-config","rust-binary","runtime","output"):
        parser.add_argument("--"+key,type=Path,required=True)
    parser.add_argument("--library", required=True)
    parser.add_argument("--rust-sha256",required=True)
    print(json.dumps(verify(parser.parse_args()),ensure_ascii=False))
