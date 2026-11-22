"""Bind the routing input to already saved identity, ontology and source records."""

from ontoweave_ontology.signatures import source_ref

from . import INPUT, digest, require

SEMANTIC_FIELDS = (
    "negated", "modality", "world_time", "timezone_hints", "event_ref", "statement_kind",
    "attribution", "time_scope_ref", "value_type", "time_alternatives",
)


def identity_statements(identity, annotations=None):
    """Use the explicit saved identity mapping, retaining the entire original record."""
    annotations = annotations or {}
    out = {}
    for statement_ref, statement in identity["statements"].items():
        candidate = statement["candidate"]
        endpoints, endpoint_refs = {}, {}
        for endpoint in statement["endpoints"]:
            key = endpoint["role"], endpoint["position"]
            endpoint_refs[key] = endpoint["occurrence_ref"]
            binding = identity["bindings"].get(endpoint["occurrence_ref"])
            if binding:
                endpoints[key] = binding["entity_ref"]
        qualifiers = []
        for index, qualifier in enumerate(candidate.get("qualifiers", [])):
            value = qualifier["value"]
            if qualifier.get("value_kind") == "限定实体":
                entity_ref = endpoints.get(("QUALIFIER_ENTITY", index))
                value = {"entity_ref": entity_ref} if entity_ref else None
            qualifiers.append({
                "role_key": qualifier.get("role") or qualifier.get("role_raw"), "value": value,
                "raw": qualifier, "position": index, "occurrence_ref": endpoint_refs.get(("QUALIFIER_ENTITY", index)),
            })
        entity_value = candidate.get("value_kind") == "客体"
        value = ({"kind": "ENTITY", "entity_ref": endpoints.get(("OBJECT", 0))} if entity_value else
                 {"kind": "VALUE", "value": candidate.get("value_raw"), "unit": candidate.get("unit")})
        semantic = annotations.get(statement_ref, {})
        out[statement_ref] = {
            "statement_ref": statement_ref,
            "library_ref": identity["library_ref"],
            "subject_ref": endpoints.get(("SUBJECT", 0)),
            "subject_label": candidate.get("subject"),
            "property_raw": candidate.get("relation_phrase"),
            "value": value,
            "qualifiers": qualifiers,
            "source_refs": [dict(source, source_ref=source.get("source_ref") or source_ref(source))
                            if source.get("precision") in {"UNIT", "TASK_ONLY"} else source
                            for source in statement["source_refs"]],
            "original": statement,
            "identity_revision": identity["identity_revision"],
            "structure_usable": candidate.get("structure_usable", True),
            "raw_times": candidate.get("times", []),
            "value_type": "DECIMAL" if candidate.get("value_kind") == "数值" else None,
            **{key: semantic[key] for key in (*SEMANTIC_FIELDS, "correction", "handover") if key in semantic},
        }
    return out


def unique_rows(rows, key, code):
    out = {}
    for row in rows:
        require(row[key] not in out, code)
        out[row[key]] = row
    return out


def load_inputs(request, bundle, statements):
    require(request.get("contract") == INPUT, "FACT_INPUT_CONTRACT_INVALID")
    require(request.get("trigger", {}).get("kind") in {
        "INITIAL", "IDENTITY_CHANGED", "ONTOLOGY_CHANGED", "TIME_CHANGED", "HUMAN_DECISION", "SOURCE_CHANGED",
    }, "FACT_TRIGGER_INVALID")
    for key in ("library_ref", "operation_ref", "identity_revision", "ontology_alignment_ref", "time_revision",
                "source_manifest_ref"):
        require(isinstance(request.get(key), str) and bool(request[key]), "FACT_INPUT_REFERENCE_MISSING")
    refs = request["statement_refs"]
    require(len(refs) == len(set(refs)) and all(isinstance(item, str) and item for item in refs),
            "FACT_INPUT_STATEMENTS_INVALID")
    result = bundle.get("result", bundle)
    require(result.get("contract") == "ontoweave-ontology-alignment-result/1"
            and all(result.get(key) == request.get(key)
                    for key in ("library_ref", "identity_revision", "base_view_revision")),
            "FACT_ONTOLOGY_SCOPE_MISMATCH")
    if bundle is result:
        require(request["ontology_alignment_ref"] in {result.get("run_ref"), result.get("alignment_ref")},
                "FACT_ONTOLOGY_REFERENCE_MISMATCH")
    else:
        require(request["ontology_alignment_ref"] in {bundle.get("bundle_ref"), bundle.get("alignment_ref")},
                "FACT_ONTOLOGY_REFERENCE_MISMATCH")
    cert = bundle.get("certificate")
    if cert is not None:
        require(cert.get("revision") == bundle["bundle_ref"] == result["target_ontology_revision"]
                and cert.get("result_sha256") == digest(result), "FACT_ONTOLOGY_CERTIFICATE_MISMATCH")
    definitions = unique_rows(bundle.get("definitions", result["definition_changes"]), "definition_ref",
                              "FACT_ONTOLOGY_DEFINITION_DUPLICATE")
    bindings = unique_rows(bundle.get("effective_bindings", result["bindings"]),
                           "binding_ref", "FACT_ONTOLOGY_BINDING_DUPLICATE")
    effective_assignments = bundle.get("effective_assignments", result["statement_assignments"])
    assignments = unique_rows((row for row in effective_assignments if row["component_role"] == "MAIN_PROPERTY"),
                              "statement_ref", "FACT_ONTOLOGY_ASSIGNMENT_DUPLICATE")
    if request.get("local_domain_reroute"):
        require(set(refs) <= assignments.keys(), "FACT_LOCAL_ONTOLOGY_SCOPE_INCOMPLETE")
    constraints = unique_rows(bundle.get("adopted_constraints", []), "constraint_ref", "FACT_CONSTRAINT_DUPLICATE")
    require(set(request.get("constraint_refs", [])) <= constraints.keys(), "FACT_CONSTRAINT_NOT_RESOLVED")
    for statement_ref, row in statements.items():
        require(row.get("statement_ref") == statement_ref and row.get("library_ref") == request["library_ref"]
                and row.get("identity_revision", request["identity_revision"]) == request["identity_revision"],
                "FACT_STATEMENT_SCOPE_MISMATCH")
    return result, definitions, bindings, assignments, constraints
