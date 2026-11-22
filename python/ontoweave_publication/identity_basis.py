"""Canonical readback of the identity basis inherited by formal publication."""
from ontoweave_identity.matching import profile_views
from ontoweave_ontology.source import load_identity

from .store import digest, require


def read_basis(store, library, revision):
    snapshot = load_identity(store, library, revision)
    bindings, occurrences, statements = (snapshot[key] for key in ("bindings","occurrences","statements"))
    require(bindings.keys() == occurrences.keys(), "IDENTITY_BASIS_BINDING_COVERAGE")
    profiles = profile_views({key:row["entity_ref"] for key,row in bindings.items()}, occurrences, statements)
    assignment = [dict(occurrence_ref=key, entity_ref=bindings[key]["entity_ref"],
                       decision_ref=bindings[key].get("decision_ref"), name=occurrences[key]["name_raw"],
                       aliases=sorted(item["name_raw"] for item in occurrences[key].get("alias_observations",[])),
                       source_sha256=digest(occurrences[key]["source_refs"])) for key in sorted(occurrences)]
    entities = [dict(entity_ref=key, display_name=row["display_name"], names=sorted(row["names"]),
                     aliases=sorted(row["aliases"]), source_sha256=digest(sorted(digest(item) for item in row["sources"])))
                for key,row in sorted(profiles.items())]
    return dict(library_ref=library, identity_revision=revision, occurrence_mapping=assignment, entities=entities,
                statements_sha256=digest(statements), source_coverage_sha256=digest(
                    [[key,digest(row["source_refs"])] for key,row in sorted(statements.items())]))


def verify_basis(store, library, revision, source_run, sources, frozen, source_manifest_ref):
    expected = frozen["basis"]
    require(frozen.get("contract") == "ontoweave-publication-identity-basis/1"
            and frozen.get("source_run") == source_run and frozen.get("source_manifest_ref") == source_manifest_ref
            and expected["library_ref"] == library and expected["identity_revision"] == revision
            and frozen["sources_sha256"] == digest(sources)
            and frozen["basis_sha256"] == digest(expected), "IDENTITY_FROZEN_BASIS_MISMATCH")
    actual = read_basis(store, library, revision)
    require(actual == expected, "IDENTITY_FROZEN_MAPPING_MISMATCH")
    return dict(status="MATCHED", identity_revision=revision, origin_view_revision=frozen["view_revision"],
                basis_sha256=frozen["basis_sha256"], occurrences=len(actual["occurrence_mapping"]),
                entities=len(actual["entities"]), source_manifest_ref=source_manifest_ref, identity_generation_requests=0)
