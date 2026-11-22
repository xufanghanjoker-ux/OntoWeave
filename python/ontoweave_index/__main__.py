"""Prepare/derive or jointly publish the index of an explicitly selected confirmed view."""
import argparse
import json
from pathlib import Path

from ontoweave_cq.store import PGCQStore
from ontoweave_facts.repository import apply_fact_bundle
from ontoweave_identity.publication import activate_for_publisher
from ontoweave_publication.coordinator import Publisher
from ontoweave_publication.runtime import isolated_pg, verify_pg
from ontoweave_publication.store import head, manifest, projection, require

from .repository import BUSINESS_KINDS, IndexRepository, migrate, publication_for_view
from .settings import index_settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("derive", "publish"))
    parser.add_argument("--pg-config", type=Path, required=True)
    parser.add_argument("--index-config", type=Path, required=True)
    parser.add_argument("--library", required=True)
    parser.add_argument("--view", required=True)
    parser.add_argument("--operation-ref", required=True)
    args = parser.parse_args()
    settings = isolated_pg(args.pg_config)
    segment, client = index_settings(json.loads(args.index_config.read_bytes()))
    require(segment is not None, "INDEX_RUNTIME_CONFIG_REQUIRED", 422)
    store = PGCQStore(settings)
    try:
        with store.transaction(readonly=True) as (q, _):
            verify_pg(q, settings)
            adopted = manifest(q, args.library, args.view)
            graph = projection(q, args.library, args.view, BUSINESS_KINDS)
            if args.action == "publish":
                state = head(q, args.library)
                require(state["active_view_revision"] == args.view and not state["pending_view_revision"],
                        "VIEW_BASE_STALE")
        migration = migrate(store)
        repository = IndexRepository(store)
        repository.register_confirmed_sources(args.library, args.view)
        prepared = repository.prepare_index(publication_for_view(adopted), graph, segment_codepoints=segment,
                                            client=client, operation_ref=args.operation_ref)
        if args.action == "publish":
            published = Publisher(store, apply_fact_bundle, activate_identity=activate_for_publisher).adopt_index(
                args.library, args.view, prepared, operation_ref=args.operation_ref)
            descriptor = repository.load_prepared_index(args.library, prepared)
        else:
            descriptor = repository.certify_historical(args.library, args.view, prepared)
            published = None
        print(json.dumps(dict(action=args.action, migration=migration, prepared=prepared,
                              descriptor=descriptor, published=published), ensure_ascii=False, indent=2))
    finally:
        store.close()


if __name__ == "__main__":
    main()
