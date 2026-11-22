"""Read local rerouting input for the shared publisher's staged domain plans."""

from collections import defaultdict
from copy import deepcopy

from . import require
from .input import SEMANTIC_FIELDS, identity_statements
from .repository import read_fact_snapshot
from .routing import group_keys_for


def _effective_ontology(bundle, snapshot, statement_refs):
    assignments = [row for row in snapshot["assignments"] if row["statement_ref"] in statement_refs]
    binding_refs = {row["binding_ref"] for row in assignments}
    return {
        **bundle,
        "definitions": bundle.get("definitions", snapshot["definitions"]),
        "effective_bindings": [row for row in snapshot["bindings"] if row["binding_ref"] in binding_refs],
        "effective_assignments": assignments,
    }


def restore_statement_annotations(base, statement_refs):
    versions = {version["fact_id"]: version for version in base["versions"]}
    owners = defaultdict(list)
    for fact_ref, supports in base["supports_by_fact"].items():
        version = versions[fact_ref]
        for support in supports:
            statement_ref = support.get("statement_ref")
            if statement_ref in statement_refs:
                owners[statement_ref].append((version, support))
    restored = {}
    for statement_ref, items in owners.items():
        require(len({version["fact_id"] for version, _ in items}) == 1, "FACT_LOCAL_SUPPORT_OWNER_AMBIGUOUS")
        version, first = items[0]
        content = version["content"]
        conditions = content["conditions"]
        # Legacy bundles preserve the asserted time on the Rust version and the
        # original time hints per support. A derived end must not become source time.
        legacy_fields = dict(negated=content["negated"], modality=content["modality"],
                             event_ref=conditions.get("event_ref"), time_scope_ref=conditions.get("time_scope_ref"))
        attributed = [pair[1] for pair in conditions.get("attribution", []) if pair[0] == "asserted_by"]
        if attributed:
            legacy_fields["attribution"] = attributed[0]
        stored = first.get("annotations", {})
        meta = base["assertions"][version["fact_id"]]
        restored[statement_ref] = {
            **legacy_fields, **stored, "world_time": version["asserted_valid_time"],
            # The version is already normalized. Keep raw hints separately for evidence.
            "timezone_hints": [], "retained_timezone_hints": first.get("timezone_hints", []),
            "time_alternatives": [{**entry, "timezone_hints": []} for entry in meta.get("time_alternatives", [])],
        }
    return restored


def prepare_local_input(q, request, adopted, history, target_identity, ontology_bundle,
                        ontology_snapshot, *, old_group_keys=(), annotations=None):
    """Read old and new groups under the caller's read-only snapshot.

    Domain owners supply the authenticated successor identity and ontology plus
    their affected statements. No Rust execution, provider calls or writes occur here.
    """
    require(request["base_view_revision"] == adopted["view_revision"]
            and request["library_ref"] == adopted["library_ref"]
            and request["source_manifest_ref"] == adopted["source_manifest_ref"],
            "FACT_LOCAL_BASE_STALE")
    require(request["trigger"]["kind"] in {"HUMAN_DECISION", "IDENTITY_CHANGED", "ONTOLOGY_CHANGED"},
            "FACT_LOCAL_TRIGGER_INVALID")
    require(target_identity["library_ref"] == request["library_ref"]
            and target_identity["identity_revision"] == request["identity_revision"], "FACT_LOCAL_IDENTITY_MISMATCH")
    require(history and history[0]["fact_revision"] == adopted["fact_revision"], "FACT_LOCAL_HISTORY_STALE")
    certificate = ontology_bundle.get("certificate")
    if certificate:
        require(certificate["parent_revision"] == adopted["ontology_revision"], "FACT_LOCAL_ONTOLOGY_PARENT_STALE")
    refs = set(request["statement_refs"])
    require(refs <= target_identity["statements"].keys(), "FACT_LOCAL_STATEMENT_MISSING")
    request = {**deepcopy(request), "local_domain_reroute": True}
    bundle = _effective_ontology(ontology_bundle, ontology_snapshot, refs)
    head = dict(activation_ref=adopted["view_revision"], activation_seq=adopted["activation_seq"])
    library = request["library_ref"]
    old = read_fact_snapshot(q, library, history, head, group_keys=sorted(set(old_group_keys)),
                             statement_refs=sorted(refs))
    for supports in old["supports_by_fact"].values():
        require(any(support.get("statement_ref") for support in supports),
                "FACT_LOCAL_UNANCHORED_HUMAN_ASSERTION")
    restored = restore_statement_annotations(old, refs)
    for statement_ref, explicit in (annotations or {}).items():
        require(statement_ref in refs and set(explicit) <= set(SEMANTIC_FIELDS), "FACT_LOCAL_ANNOTATION_SCOPE_INVALID")
        restored.setdefault(statement_ref, {}).update(explicit)
        if "world_time" in explicit:
            restored[statement_ref].pop("retained_timezone_hints", None)
    identity = {**target_identity, "statements": {key: target_identity["statements"][key] for key in sorted(refs)}}
    statements = identity_statements(identity, restored)
    for statement_ref, row in statements.items():
        hints = restored.get(statement_ref, {}).get("retained_timezone_hints")
        if hints:
            row["retained_timezone_hints"] = hints
    keys = set(group_keys_for(request, bundle, statements)) | set(old["affected_group_keys"])
    base = read_fact_snapshot(q, library, history, head, group_keys=sorted(keys))
    previous_sources = defaultdict(dict)
    for support in old["supports"]:
        previous_sources[support.get("statement_ref")][support["rust_source"]["source_version_id"]] = support["rust_source"]
    for statement_ref, row in statements.items():
        row["previous_sources"] = dict(previous_sources[statement_ref])
    return dict(request=request, ontology_bundle=bundle, statements=statements, base=base)
