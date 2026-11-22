"""Validate local short-label judgments and generate immutable program references."""

import json
from collections import defaultdict

from ontoweave_cq_similarity.core import digest
from ontoweave_identity.input import name_key, ref

from .repository import OBSERVATIONS, combine_definition
from .signatures import SIMPLIFIED, source_ref

TIME = {"START", "END", "OCCURRED", "OBSERVED", "UNKNOWN"}
ROLES = {"SCOPE", "ATTRIBUTION", "MODALITY", "CONTEXT", "UNKNOWN"}
CONSTRAINTS = {"SINGLE_VALUE", "DISJOINT", "INVERSE_UNIQUE", "DOMAIN", "RANGE", "PARENT"}
ACTIONS = {"OPEN", "NEEDS_REVIEW", "NEW", "REUSE", "ROLE"}


def text(value, limit=1200):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _refs(members):
    return sorted({member["target"]["statement_ref"] for member in members})


def _supports(members):
    rows = {}
    for member in members:
        statement_ref = member["target"]["statement_ref"]
        for source in member["statement"]["source_refs"]:
            if source["precision"] != "UNIT":
                continue
            key = (statement_ref, source_ref(source))
            rows[key] = dict(statement_ref=statement_ref, source_ref=key[1], source_revision=source["revision"],
                             unit_ref=source["unit_ref"], evidence_role=member["target"]["component_role"],
                             text_sha256=source["text_sha256"])
    return list(rows.values())


def build_binding(library, group, members, evidence, state, *, definition=None, direction=None,
                  role=None, time="UNKNOWN", reason="", method="AGENT", role_map=None):
    property_kind = group["kind"]
    qualifiers = []
    if role is not None:
        qualifiers.append(dict(source_role_key=members[0]["shape"]["source_role_key"], semantic_role=role,
                               role_definition_ref=None, evidence_statement_refs=_refs(evidence)))
    for key, semantic in sorted((role_map or {}).items()):
        qualifiers.append(dict(source_role_key=key, semantic_role=semantic, role_definition_ref=None,
                               evidence_statement_refs=_refs(evidence)))
    treatment = ({"ATTRIBUTE": "PRESERVE_VALUE", "RELATION": "PRESERVE_ENTITY"}.get(property_kind)
                 if state == "BOUND" else "OPEN")
    payload = dict(alignment_signature_ref=group["alignment_signature_ref"],
                   binding_state=state, definition_ref=definition and definition["definition_ref"],
                   direction=direction, object_treatment=treatment, qualifier_roles=qualifiers,
                   time_semantics=time, reason=reason, method=method, basis_sha256=group["basis_sha256"],
                   evidence_statement_refs=_refs(evidence))
    return dict(binding_ref=ref("binding", [library, payload]), **payload)


def _looks_supported(evidence):
    return bool(evidence) and all(
        any(s["precision"] == "UNIT" for s in member["statement"]["source_refs"])
        and (member["kind"] != "TYPE" or member["type_evidence"])
        for member in evidence
    )


def _resolve(library, entry, row, members, evidence, labels, definitions, proposals, proposal_labels):
    group = entry["group"]
    kind = group["kind"]
    action = row["action"]
    simplified = group.get("alignment_contract") == SIMPLIFIED
    role_map = row.get("qualifier_roles", {})
    if simplified:
        allowed_roles = {q.get("role") or q.get("role_raw")
                         for m in members for q in m["statement"]["candidate"].get("qualifiers", [])}
        if (not isinstance(role_map, dict) or any(k not in allowed_roles or v not in ROLES
                                                  for k, v in role_map.items())):
            raise ValueError("QUALIFIER_ROLE_OUT_OF_SCOPE")
    direction = row.get("direction")
    time = row.get("time_semantics", "UNKNOWN")
    role = row.get("qualifier_role")
    if time not in TIME or not text(row.get("reason")):
        raise ValueError("INVALID_JUDGMENT")
    if action in ("NEW", "REUSE"):
        if kind not in ("TYPE", "RELATION", "ATTRIBUTE") or not _looks_supported(evidence):
            raise ValueError("INSUFFICIENT_SUPPORT")
        directions = {"TYPE": [None], "ATTRIBUTE": ["FORWARD"], "RELATION": ["FORWARD", "REVERSE"]}[kind]
        if action == "REUSE":
            label = row.get("definition")
            if label not in entry["allowed"]:
                raise ValueError("CANDIDATE_OUT_OF_SCOPE")
            definition = labels[label]
            directions = entry["allowed"][label] if kind != "TYPE" else [None]
        else:
            label = row.get("proposal")
            if not text(label, 80):
                raise ValueError("INVALID_PROPOSAL")
            definition = proposal_labels.get(label)
            if definition is None:
                name, description = row.get("label"), row.get("description")
                if not text(name, 120) or not text(description) or direction not in directions:
                    raise ValueError("INVALID_DEFINITION")
                boundary = row.get("boundary", "")
                if simplified and boundary != "" and not text(boundary):
                    raise ValueError("INVALID_DEFINITION_BOUNDARY")
                core = [library, kind, " ".join(name.split()), " ".join(description.split())]
                if simplified:
                    core.append(" ".join(boundary.split()))
                key = ref("definition", core)
                definition = dict(definition_key=key, definition_ref=ref("definition_version", [key, "PROVISIONAL"]),
                                  kind=kind, label=" ".join(name.strip().split()), description=" ".join(description.strip().split()),
                                  definition_status="PROVISIONAL", constraint_refs=[], observed_domains=[],
                                  observed_ranges=[], observed_datatypes=[], source_statement_refs=[], supports=[])
                if simplified:
                    definition["boundary"] = core[-1]
            elif definition["kind"] != kind or any(
                k in row and (" ".join(row[k].split()) != definition.get(k, "") if simplified
                              else name_key(row[k]) != name_key(definition[k]))
                for k in (("label", "description", "boundary") if simplified else ("label", "description"))
            ):
                raise ValueError("PROPOSAL_MEANING_CHANGED")
        if direction not in directions:
            raise ValueError("DIRECTION_NOT_ALLOWED")
        constraint = row.get("constraint")
        if constraint is not None:
            if (not isinstance(constraint, dict) or constraint.get("kind") not in CONSTRAINTS
                    or not text(constraint.get("scope")) or not text(constraint.get("description"))):
                raise ValueError("INVALID_CONSTRAINT_PROPOSAL")
            payload = dict(definition_ref=definition["definition_ref"], kind=constraint["kind"],
                           scope=constraint["scope"], description=constraint["description"],
                           supports=_supports(evidence), source_statement_refs=_refs(evidence),
                           adoption_decision_ref=None)
            key = ref("constraint_proposal", [library, payload])
            proposals[key] = dict(proposal_ref=key, **payload)
        key = definition["definition_ref"]
        observation = {k: v for k, v in definition.items() if k not in OBSERVATIONS}
        observation.update({k: [] for k in OBSERVATIONS})
        for member in evidence:
            shape = member["shape"]
            domains, ranges = shape.get("subject_types", []), shape.get("object_types", [])
            if direction == "REVERSE":
                domains, ranges = ranges, domains
            for field, values in (("observed_domains", domains), ("observed_ranges", ranges),
                                  ("observed_datatypes", [shape["value_kind"]] if kind == "ATTRIBUTE" else []),
                                  ("source_statement_refs", _refs([member]))):
                observation[field] = sorted(set(observation[field]).union(values))
        # Each accepted representative covers a precomputed protected cohort.
        # Keep the model citation separate from links to all covered source records.
        observation["supports"] = _supports(members if simplified else evidence)
        if simplified:
            observation["source_statement_refs"] = _refs(members)
        definitions[key] = combine_definition(definitions.get(key), observation)
        if action == "NEW":
            proposal_labels[label] = observation
        return build_binding(library, group, members, evidence, "BOUND", definition=definition,
                             direction=direction, time=time, reason=row["reason"], role_map=role_map if simplified else None)
    if action == "ROLE":
        if kind != "QUALIFIER" or role not in ROLES or not _looks_supported(evidence):
            raise ValueError("INVALID_QUALIFIER_ROLE")
        return build_binding(library, group, members, evidence, "BOUND" if role != "UNKNOWN" else "OPEN",
                             role=role, time=time, reason=row["reason"])
    return build_binding(library, group, members, evidence, action, reason=row["reason"])


def receive(library, batch, messages):
    records = defaultdict(list)
    warnings = []
    labels = batch["labels"]
    definitions, proposals, proposal_labels, mapped = {}, {}, {}, []
    for message in messages:
        for number, line in enumerate(message["text"].splitlines(), 1):
            line = line.strip()
            if not line or line in ("```", "```json", "```jsonl"):
                continue
            try:
                row = json.loads(line)
                signature = row["signature"]
                if signature not in labels["signatures"]:
                    raise ValueError
            except (ValueError, TypeError, KeyError):
                warnings.append(dict(code="UNSCOPED_JUDGMENT", line=number, can_continue=True))
                continue
            records[signature].append(row)

    for signature, entry in labels["signatures"].items():
        evidence = entry["evidence"]
        group = entry["group"]
        represented = entry.get("represented", {k: [v] for k, v in evidence.items()})
        entries = []
        used = defaultdict(int)
        for row in records[signature]:
            keys = row.get("members", list(evidence))
            if (not isinstance(keys, list) or not keys or any(not isinstance(k, str) or k not in evidence for k in keys)
                    or len(set(keys)) != len(keys)):
                warnings.append(dict(code="MEMBERS_OUT_OF_SCOPE", signature=signature, can_continue=True))
                continue
            for key in keys:
                used[key] += 1
            entries.append((row, keys))
        covered = set()
        for row, keys in entries:
            if any(used[k] != 1 for k in keys):
                continue
            members = [member for k in keys for member in represented[k]]
            try:
                cited = row["evidence"]
                if (row["action"] not in ACTIONS or not isinstance(cited, list)
                        or any(not isinstance(k, str) or k not in keys for k in cited)):
                    raise ValueError("EVIDENCE_OUT_OF_SCOPE")
                if (entry.get("represented") and row["action"] in {"NEW", "REUSE"}
                        and set(cited) != set(keys)):
                    raise ValueError("REPRESENTATIVE_EVIDENCE_MISSING")
                binding = _resolve(library, entry, row, members, [evidence[k] for k in cited],
                                   labels["definitions"], definitions, proposals, proposal_labels)
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                code = str(exc) if isinstance(exc, ValueError) else "MALFORMED_JUDGMENT"
                warnings.append(dict(code=code, signature=signature, can_continue=True))
                continue
            covered.update(keys)
            mapped.extend((member["target"], binding) for member in members)
        for key in sorted(evidence.keys() - covered):
            member = evidence[key]
            code = "DUPLICATE_MEMBER_JUDGMENT" if used[key] > 1 else "MISSING_OR_INVALID_JUDGMENT"
            warnings.append(dict(code=code, signature=signature, statement_ref=member["target"]["statement_ref"],
                                 can_continue=True))
            unresolved = represented[key]
            binding = build_binding(library, group, unresolved, [], "OPEN", reason=code, method="PROGRAM")
            mapped.extend((item["target"], binding) for item in unresolved)
    return dict(mapped=mapped, definitions=list(definitions.values()), proposals=list(proposals.values()), warnings=warnings)
