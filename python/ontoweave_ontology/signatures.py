"""Build conservative, replayable groups from source-local statement shapes."""

from collections import defaultdict
from itertools import batched

from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest
from ontoweave_identity.input import name_key, ref, source_key

from .material_context import source_context

SIMPLIFIED = "ontology-alignment/2"


def source_ref(source):
    key = source_key(source) if source["precision"] == "UNIT" else (source["task_ref"],)
    return ref("source", [source["precision"], key])


def _components(statement, occurrences, bindings, declarations, *, simplified=False):
    candidate = statement["candidate"]
    observed = {}
    for endpoint in statement["endpoints"]:
        occurrence_ref = endpoint["occurrence_ref"]
        require(occurrence_ref in occurrences and occurrence_ref in bindings, "ONTOLOGY_ENDPOINT_UNBOUND")
        occurrence = occurrences[occurrence_ref]
        binding = bindings[occurrence_ref]
        sources = {source_ref(s) for s in occurrence["source_refs"]}
        local = [row for row in declarations[binding["entity_ref"]]
                 if sources.intersection(source_ref(s) for s in row["source_refs"])]
        rows = [occurrence, *local]
        words = sorted({o["type_raw"] for row in rows for o in row["type_observations"]})
        observed[endpoint["role"], endpoint["position"]] = (occurrence_ref, binding, words, local)

    subject_types = observed.get(("SUBJECT", 0), (None, None, [], []))[2]
    object_types = observed.get(("OBJECT", 0), (None, None, [], []))[2]
    qualifiers = candidate.get("qualifiers", [])
    object_kind = ("ENTITY" if ("OBJECT", 0) in observed else
                   "VALUE" if candidate.get("value_kind") and candidate.get("value_kind") != "客体" else "OPEN")
    surface = candidate.get("relation_phrase") or candidate.get("predicate") or ""
    statement_kind = candidate.get("statement_kind")
    kind = {"ENTITY": "RELATION", "VALUE": "ATTRIBUTE"}.get(object_kind)
    if (not candidate.get("structure_usable") or
            statement["disposition"] not in ("STRUCTURED", "RELATION", "ATTRIBUTE") or ("SUBJECT", 0) not in observed):
        kind = None
    yield (dict(component_role="MAIN_PROPERTY"), surface, kind, dict(
        subject_types=subject_types, object_types=object_types, object_kind=object_kind,
        value_kind=candidate.get("value_kind"), unit=candidate.get("unit"), statement_kind=statement_kind,
        qualifiers=[[q.get("role_raw") or q.get("label") or q.get("key") or q.get("role"), q.get("value_kind")] for q in qualifiers],
        modality_context=candidate.get("extensions"), extras=candidate.get("extras"),
        time_shape=[t.get("kind") or t.get("role") for t in candidate.get("times", [])],
    ), [])
    for (role, _), (target, binding, names, local) in observed.items():
        if role not in ("SUBJECT", "OBJECT"):
            continue
        for word in names:
            evidence = [dict(type_raw=word, entity_ref=binding["entity_ref"], declaration_ref=row["occurrence_ref"],
                             sources=row["source_refs"])
                        for row in local if word in {o["type_raw"] for o in row["type_observations"]}]
            yield (dict(component_role=role + "_TYPE", target_occurrence_ref=target, type_observation=word),
                   word, "TYPE", {}, evidence)
    for i, qualifier in enumerate(qualifiers if not simplified else ()):
        word = qualifier.get("role_raw") or qualifier.get("label") or qualifier.get("key") or qualifier.get("role") or qualifier.get("name") or ""
        yield (dict(component_role="QUALIFIER_ROLE", qualifier_position=i), word, "QUALIFIER",
               dict(source_role_key=qualifier.get("role") or word, value_kind=qualifier.get("value_kind"), property_surface=name_key(surface),
                    subject_types=subject_types, object_kind=object_kind), [])


def group(identity, statement_refs, *, simplified=False):
    occurrences, bindings = identity["occurrences"], identity["bindings"]
    declarations = defaultdict(list)
    for key, occurrence in sorted(occurrences.items()):
        if occurrence["role"] == "DECLARATION" and key in bindings:
            declarations[bindings[key]["entity_ref"]].append(occurrence)
    by_context = defaultdict(list)
    for statement_ref in sorted(statement_refs):
        statement = identity["statements"][statement_ref]
        require(statement["statement_ref"] == statement_ref and statement["source_refs"],
                "ONTOLOGY_STATEMENT_EVIDENCE_MISSING")
        for source in statement["source_refs"]:
            if source["precision"] == "UNIT":
                require(all(source.get(k) for k in ("doc_ref", "revision", "unit_ref")) and
                        sha(source["text"]) == source["text_sha256"], "ONTOLOGY_SOURCE_CHANGED")
            else:
                require(source["precision"] == "TASK_ONLY" and source.get("task_ref"), "ONTOLOGY_SOURCE_INVALID")
        context = sorted((source_ref(s), digest(s)) for s in statement["source_refs"])
        endpoints = [dict(**end, identity=bindings[end["occurrence_ref"]]) for end in statement["endpoints"]]
        for target, surface, kind, shape, type_evidence in _components(statement, occurrences, bindings, declarations, simplified=simplified):
            shape_key = ref("shape", [kind, name_key(surface), shape])
            by_context[shape_key, digest(context)].append(dict(
                target=dict(statement_ref=statement_ref, **target), surface=surface, kind=kind, shape=shape,
                statement=statement, endpoints=endpoints, type_evidence=type_evidence))
    groups = []
    for (shape_key, context), members in sorted(by_context.items()):
        for examples in (members,) if simplified else batched(members, 3):
            signature_ref = ref("signature", [identity["library_ref"], shape_key, context,
                                             [m["target"] for m in examples]])
            groups.append(dict(alignment_signature_ref=signature_ref, shape_key=shape_key, context_basis=context,
                               members=list(examples), kind=examples[0]["kind"]))
            if simplified:
                groups[-1]["alignment_contract"] = SIMPLIFIED
    return groups


def representative_cohorts(signature):
    """Share judgments only among members with the same observed semantic context."""
    cohorts = defaultdict(list)
    for member in signature["members"]:
        statement = member["statement"]
        candidate = statement["candidate"]
        locations = []
        for source in statement["source_refs"]:
            _, spans = source_context(source, candidate)
            locations.append([source_ref(source), spans or statement["record"]["raw_utf8"]])
        protected = {key: candidate[key] for key in (
            "qualifiers", "times", "unit", "extensions", "extras", "negated", "polarity",
            "modality", "attribution", "time_precision", "timezone", "statement_kind") if key in candidate}
        cohorts[digest([locations, protected, member["shape"]])].append(member)
    return list(cohorts.values())
