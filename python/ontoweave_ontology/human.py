"""Source-bound ontology reviews and immutable scoped follow-up plans."""

from collections import defaultdict

from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest
from ontoweave_identity.input import ref

from . import RESULT_CONTRACT
from .repository import OBSERVATIONS, OntologyRepository, combine_definition, routing_projection
from .signatures import source_ref
from .source import load_identity

PLAN = "ontoweave-ontology-domain-plan/2"
DIRECTIONS = {"FORWARD", "REVERSE"}
CONSTRAINT_KINDS = {"SINGLE_VALUE", "INVERSE_UNIQUE"}
ACTION_LABELS = {
    "KEEP_DISTINCT": "保持两个定义独立",
    "ALIAS": "合并同义表达并复用目标定义",
    "REBIND": "改绑所选来源表达",
    "ADOPT_CONSTRAINT": "在核对范围内采用约束",
    "DEFER": "暂缓判断",
}


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _side_evidence(identity, refs, allowed_sources=None):
    evidence = {}
    for statement_ref in sorted(set(refs)):
        statement = identity["statements"].get(statement_ref)
        if not statement:
            continue
        for source in statement["source_refs"]:
            if (source.get("precision") != "UNIT" or not all(source.get(k) for k in ("doc_ref", "revision", "unit_ref"))
                    or not _text(source.get("text")) or sha(source["text"]) != source.get("text_sha256")):
                continue
            key = source_ref(source)
            if allowed_sources is not None and (statement_ref, key) not in allowed_sources:
                continue
            evidence[statement_ref, key] = dict(
                source_ref=key, statement_ref=statement_ref, precision="UNIT",
                preview=source["text"], text=source["text"], location=dict(source, source_ref=key),
                raw_statement=statement["record"]["raw_utf8"],
                raw_qualifiers=statement["candidate"].get("qualifiers", []),
                raw_times=statement["candidate"].get("times", []),
            )
    return list(evidence.values())


def _side(definition, entries, identity):
    refs = sorted({a["statement_ref"] for a, _ in entries})
    supported = {(row["statement_ref"], row["source_ref"]) for row in definition.get("supports", [])}
    evidence = _side_evidence(identity, refs, supported)
    properties = set()
    for row, _ in entries:
        statement = identity["statements"].get(row["statement_ref"])
        if row.get("type_observation"):
            properties.add(row["type_observation"])
        elif statement:
            candidate = statement["candidate"]
            value = candidate.get("relation_phrase") or candidate.get("predicate")
            if value:
                properties.add(value)
    return dict(definition_ref=definition["definition_ref"], label=definition["label"],
                property=definition["label"], description=definition["description"],
                kind=definition["kind"], raw_properties=sorted(properties), statement_refs=refs,
                binding_refs=sorted({b["binding_ref"] for _, b in entries}),
                source_refs=sorted({e["source_ref"] for e in evidence}), evidence=evidence)


def _scoped(snapshot, references):
    refs = set(references)
    return [assignment for assignment in snapshot["assignments"] if assignment["statement_ref"] in refs]


def _entries(snapshot):
    bindings = {row["binding_ref"]: row for row in snapshot["bindings"]}
    grouped = defaultdict(list)
    for assignment in snapshot["assignments"]:
        binding = bindings[assignment["binding_ref"]]
        if binding["binding_state"] == "BOUND" and binding["definition_ref"]:
            grouped[binding["definition_ref"]].append((assignment, binding))
    return grouped


def _facts(rows, refs):
    refs = set(refs)
    return sorted((row for row in rows if refs.intersection(row.get("statement_refs", []))),
                  key=lambda row: row["fact_ref"])


def _impact(refs, bindings, facts):
    fact_rows = _facts(facts, refs)
    return dict(affected_statement_refs=sorted(set(refs)),
                affected_signature_refs=sorted({b["alignment_signature_ref"] for b in bindings}),
                affected_fact_refs=[row["fact_ref"] for row in fact_rows],
                affected_group_refs=sorted({row["group_key"] for row in fact_rows if row.get("group_key")}),
                group_keys=sorted({row["group_key"] for row in fact_rows if row.get("group_key")}))


def _scope(row):
    return row.get("content", {}).get("conditions", {}).get("scope")


def _verified_scope(scope):
    return isinstance(scope, list) and bool(scope) and all(
        isinstance(item, list) and len(item) == 2 and _text(item[0]) and item[1] is not None for item in scope)


def build_review(store, adopted, feedback, *, facts=()):
    """Return a review only when both sides and an executable action are source-bound."""
    library, view = adopted["library_ref"], adopted["view_revision"]
    require(feedback.get("base_view_revision") == view, "ONTOLOGY_REVIEW_STALE")
    suggestion = feedback.get("suggested_revision")
    if not isinstance(suggestion, dict) or not _text(feedback.get("business_problem")):
        return None
    facts = tuple(facts)
    repository = OntologyRepository(store)
    snapshot = repository.snapshot(library, adopted["ontology_revision"])
    identity = load_identity(store, library, adopted["identity_revision"])
    definitions = {row["definition_ref"]: row for row in snapshot["definitions"]}
    left = definitions.get(feedback.get("definition_ref"))
    if not left or left["definition_status"] == "RETIRED":
        return None
    entries = _entries(snapshot)
    left_ref = left["definition_ref"]
    if suggestion.get("kind") == "COMPARE_DEFINITIONS":
        comparison = _compare_definitions(snapshot, definitions, entries, identity, left, suggestion)
    elif suggestion.get("kind") == "ADOPT_CONSTRAINT":
        comparison = _compare_constraint(repository, adopted, snapshot, entries, identity, left, suggestion, facts)
    else:
        return None
    if comparison is None:
        return None
    sides, selected, actions, context = comparison
    if not selected or any(not side["evidence"] for side in sides):
        return None
    refs = sorted({a["statement_ref"] for a, _ in selected})
    impact = _impact(refs, [b for _, b in selected], facts)
    context.update(selected=[dict(statement_ref=a["statement_ref"], binding_ref=b["binding_ref"])
                             for a, b in selected])
    if feedback.get("fact_refs") and not set(feedback["fact_refs"]) <= {
        row["fact_ref"] for row in _facts(facts, {s for side in sides for s in side["statement_refs"]})
    }:
        return None
    domain_key = context.get("pair") or [left_ref, context["proposal"]["proposal_ref"], context["scope"]]
    review_ref = ref("ontology_review", [library, domain_key, context.get("requested_binding_refs", [])])
    if review_ref in {row["review_ref"] for row in snapshot["review_resolutions"]}:
        return None
    if context.get("pair") and any(
        row["action"] == "KEEP_DISTINCT" and row["pair"] == context["pair"]
        for row in snapshot["review_resolutions"]
    ):
        return None
    evidence = [row for side in sides for row in side["evidence"]]
    basis_data = [library, view, adopted["identity_revision"], adopted["ontology_revision"],
                  context, sides, impact, actions]
    return dict(review_ref=review_ref, logical_review_key=review_ref, review_kind="ONTOLOGY",
                target_kind="ONTOLOGY", review_status="OPEN", basis_version=ref("ontology_review_basis", basis_data),
                basis=dict(view_revision=view, identity_revision=adopted["identity_revision"],
                           ontology_revision=adopted["ontology_revision"], evidence_sha=digest(evidence)),
                title=f"核对「{left['label']}」的表达与定义", question=feedback["business_problem"],
                conflict_reason="来源与适用范围需要人工确认",
                sides=sides, evidence=evidence, source_refs=sorted({row["source_ref"] for row in evidence}),
                differences={key: [side.get(key) for side in sides] for key in (
                    "label", "description", "raw_properties", "scope") if sides[0].get(key) != sides[1].get(key)},
                available_actions=[_action(kind, left["kind"]) for kind in actions],
                impact=dict(impact, check_status="PENDING_PREVIEW"), comparison=context,
                feedback_basis={k: feedback[k] for k in ("base_view_revision", "definition_ref", "business_problem",
                                                         "suggested_revision", "fact_refs", "source_refs") if k in feedback})


def _action(kind, definition_kind):
    fields = ["reason"]
    if definition_kind == "RELATION" and kind in {"ALIAS", "REBIND"}:
        fields.append("relative_direction")
    return dict(kind=kind, label=ACTION_LABELS[kind], required_fields=fields,
                **({"allowed_relative_directions": sorted(DIRECTIONS)} if "relative_direction" in fields else {}))


def _compare_definitions(snapshot, definitions, entries, identity, left, suggestion):
    right = definitions.get(suggestion.get("other_definition_ref"))
    left_ref = left["definition_ref"]
    if (not right or right["definition_ref"] == left_ref or right["kind"] != left["kind"]
            or right["definition_status"] == "RETIRED"):
        return None
    right_ref = right["definition_ref"]
    # An adopted operational rule or prior alias needs its own review before combining meaning.
    if (any(row["definition_ref"] in {left_ref, right_ref} for row in snapshot["adopted_constraints"])
            or left.get("constraint_refs") or right.get("constraint_refs")
            or {left_ref, right_ref}.intersection(snapshot["definition_aliases"])):
        return None
    left_entries = entries[left_ref]
    scoped = suggestion.get("binding_refs", [])
    if not isinstance(scoped, list) or any(not _text(item) for item in scoped) or len(set(scoped)) != len(scoped):
        return None
    if not set(scoped) <= {b["binding_ref"] for _, b in left_entries}:
        return None
    selected = [item for item in left_entries if not scoped or item[1]["binding_ref"] in scoped]
    context = dict(kind="COMPARE_DEFINITIONS", pair=sorted((left_ref, right_ref)), from_definition_ref=left_ref,
                   to_definition_ref=right_ref, requested_binding_refs=sorted(scoped))
    left_side, right_side = _side(left, selected, identity), _side(right, entries[right_ref], identity)
    if not left_side["evidence"] or not right_side["evidence"]:
        return None
    # Every proposed remap must be inspectable. Binding evidence may be a subset of group members.
    if left_side["statement_refs"] != sorted({row["statement_ref"] for row in left_side["evidence"]}):
        return None
    actions = ["KEEP_DISTINCT", "REBIND" if scoped else "ALIAS", "DEFER"]
    return [left_side, right_side], selected, actions, context


def _compare_constraint(repository, adopted, snapshot, entries, identity, definition, suggestion, facts):
    scope = suggestion.get("scope")
    proposal_ref = suggestion.get("proposal_ref")
    if not _verified_scope(scope) or not _text(proposal_ref):
        return None
    proposal = repository.read_constraint_proposal(adopted["library_ref"], adopted["ontology_revision"], proposal_ref)
    if (not proposal or proposal["definition_ref"] != definition["definition_ref"]
            or proposal["kind"] not in CONSTRAINT_KINDS or not _text(proposal.get("description"))
            or proposal.get("adoption_decision_ref") or any(
                row["proposal_ref"] == proposal_ref and row["scope"] == scope
                for row in snapshot["adopted_constraints"])):
        return None
    supported = {(row["statement_ref"], row["source_ref"]) for row in proposal.get("supports", [])}
    source_evidence = _side_evidence(identity, proposal["source_statement_refs"], supported)
    source_refs = {row["source_ref"] for row in source_evidence}
    matching = [row for row in facts if row.get("definition_ref") == definition["definition_ref"] and _scope(row) == scope]
    # The scoped assertion shown to the reviewer must be tied to a source of the proposal.
    if not source_evidence or not any(source_refs.intersection(row.get("source_refs", [])) for row in matching):
        return None
    refs = {ref for row in matching for ref in row["statement_refs"]}
    selected = [item for item in entries[definition["definition_ref"]] if item[0]["statement_ref"] in refs]
    side = _side(definition, selected, identity)
    left = dict(definition_ref=definition["definition_ref"], label=proposal["kind"],
                description=proposal["description"], scope=proposal["scope"], evidence=source_evidence,
                source_refs=sorted(source_refs), statement_refs=proposal["source_statement_refs"])
    return [left, dict(side, scope=scope)], selected, ["ADOPT_CONSTRAINT", "DEFER"], dict(
        kind="ADOPT_CONSTRAINT", proposal=proposal, scope=scope)


def _result(adopted, identity_revision, operation, assignments, bindings, refs, **fields):
    by_ref = {b["binding_ref"]: b for b in bindings}
    open_refs = set(refs)
    for assignment in assignments:
        if (assignment["component_role"] == "MAIN_PROPERTY" and
                by_ref[assignment["binding_ref"]]["binding_state"] == "BOUND"):
            open_refs.discard(assignment["statement_ref"])
    return dict(contract=RESULT_CONTRACT, library_ref=adopted["library_ref"],
                base_view_revision=adopted["view_revision"], identity_revision=identity_revision,
                run_ref=ref("ontology_domain_operation", [adopted["library_ref"], operation, adopted["view_revision"]]),
                execution_status="COMPLETED", definition_changes=[], bindings=sorted(by_ref.values(), key=lambda b: b["binding_ref"]),
                statement_assignments=sorted(assignments, key=digest), constraint_proposals=[],
                open_statement_refs=sorted(open_refs), processed_statement_refs=sorted(refs),
                affected_statement_refs=sorted(refs), withdrawn_statement_refs=[], warnings=[],
                **fields)


def _plan(adopted, snapshot, result, input_basis, before, after, impact):
    pin = digest(input_basis)
    parent = adopted["ontology_revision"]
    revision = ref("ontology_revision", [parent, pin, result])
    result = dict(result, target_ontology_revision=revision)
    definitions = {row["definition_ref"]: row for row in snapshot["definitions"]}
    for row in result["definition_changes"]:
        key = row["definition_ref"]
        definitions[key] = combine_definition(definitions.get(key), row)
    processed = set(result["processed_statement_refs"])
    assignments = [row for row in snapshot["assignments"] if row["statement_ref"] not in processed]
    assignments.extend(result["statement_assignments"])
    bindings = {row["binding_ref"]: row for row in [*snapshot["bindings"], *result["bindings"]]}
    projection = dict(definitions=list(definitions.values()), assignments=assignments,
                      bindings=[bindings[k] for k in sorted({row["binding_ref"] for row in assignments})],
                      adopted_constraints=[*snapshot["adopted_constraints"], *result.get("adopted_constraints", [])],
                      definition_aliases=dict(snapshot["definition_aliases"], **result.get("definition_aliases", {})),
                      review_resolutions=[*snapshot["review_resolutions"], *result.get("review_resolutions", [])])
    plan = dict(contract=PLAN, parent_ontology_revision=parent, parent_identity_revision=adopted["identity_revision"],
                input_sha256=pin, result=result, routing_bundle=routing_projection(result, projection),
                snapshot=projection, library_ref=result["library_ref"],
                base_view_revision=result["base_view_revision"], identity_revision=result["identity_revision"],
                ontology_revision=revision, before=before, after=dict(after, ontology_revision=revision), impact=impact,
                **{k: impact[k] for k in ("affected_statement_refs", "affected_signature_refs", "affected_group_refs")})
    return dict(plan, plan_sha256=digest(plan))


def plan_decision(store, adopted, review, intent, *, decision_ref, operation_ref, actor_ref, facts=()):
    """Calculate an immutable delta from the same reviewed basis and authorized intent."""
    require(_text(decision_ref) and _text(operation_ref) and _text(actor_ref), "ONTOLOGY_DECISION_IDENTITY_REQUIRED")
    require(review.get("review_status") in {"OPEN", "DEFERRED"}, "ONTOLOGY_REVIEW_CLOSED")
    facts = tuple(facts)
    fresh = build_review(store, adopted, review["feedback_basis"], facts=facts)
    require(fresh and fresh["review_ref"] == review["review_ref"] and
            fresh["basis_version"] == review["basis_version"], "ONTOLOGY_REVIEW_STALE")
    action, reason = intent.get("kind"), intent.get("reason")
    require(action in {a["kind"] for a in fresh["available_actions"]} - {"DEFER"} and _text(reason),
            "ONTOLOGY_ACTION_INVALID")
    snapshot = OntologyRepository(store).snapshot(adopted["library_ref"], adopted["ontology_revision"])
    comparison = fresh["comparison"]
    refs = fresh["impact"]["affected_statement_refs"] if action != "KEEP_DISTINCT" else []
    old_bindings = {row["binding_ref"]: row for row in snapshot["bindings"]}
    assignments = _scoped(snapshot, refs)
    selected = {(row["statement_ref"], row["binding_ref"]) for row in comparison["selected"]}
    resolution = dict(review_ref=review["review_ref"], decision_ref=decision_ref, actor_ref=actor_ref,
                      basis_version=fresh["basis_version"], action=action, reason=reason.strip(),
                      pair=comparison.get("pair"))
    adopted_policies, aliases, new_bindings, changes = [], {}, {}, []
    if action == "ADOPT_CONSTRAINT":
        proposal = comparison["proposal"]
        policy = dict(status="ADOPTED", basis_ref=proposal["proposal_ref"], proposal_ref=proposal["proposal_ref"],
                      decision_ref=decision_ref, actor_ref=actor_ref, kind=proposal["kind"],
                      definition_ref=proposal["definition_ref"], scope=comparison["scope"],
                      source_statement_refs=proposal["source_statement_refs"], supports=proposal["supports"])
        adopted_policies.append(dict(policy, constraint_ref=ref("ontology_constraint", [adopted["library_ref"], policy])))
    elif action in {"ALIAS", "REBIND"}:
        kind = fresh["sides"][0]["kind"]
        relative = intent.get("relative_direction")
        require((kind == "RELATION" and relative in DIRECTIONS) or (kind != "RELATION" and relative is None),
                "ONTOLOGY_DIRECTION_INVALID")
        target = comparison["to_definition_ref"]
        if action == "ALIAS":
            aliases[comparison["from_definition_ref"]] = dict(
                definition_ref=target, relative_direction=relative, decision_ref=decision_ref)
        for assignment in assignments:
            key = (assignment["statement_ref"], assignment["binding_ref"])
            if key in selected and key[1] not in new_bindings:
                old = old_bindings[key[1]]
                direction = old["direction"]
                if relative == "REVERSE":
                    direction = {"FORWARD": "REVERSE", "REVERSE": "FORWARD"}[direction]
                payload = {k: v for k, v in old.items() if k != "binding_ref"}
                payload.update(definition_ref=target, direction=direction, method="HUMAN",
                               supersedes=old["binding_ref"], decision_ref=decision_ref, reason=reason.strip())
                new_bindings[key[1]] = dict(binding_ref=ref("binding", [adopted["library_ref"], payload]), **payload)
        target_definition = next(row for row in snapshot["definitions"] if row["definition_ref"] == target)
        source_definition = next(row for row in snapshot["definitions"]
                                 if row["definition_ref"] == comparison["from_definition_ref"])
        observations = {k: [] for k in OBSERVATIONS}
        observations["source_statement_refs"] = refs
        observations["supports"] = [row for row in source_definition["supports"] if row["statement_ref"] in refs]
        changes.append(dict(target_definition, **observations))
    before = dict(sides=fresh["sides"], selected_assignments=[row for row in assignments
                  if (row["statement_ref"], row["binding_ref"]) in selected])
    changed = []
    resolved_bindings = {}
    for assignment in assignments:
        key = assignment["binding_ref"]
        binding = new_bindings.get(key) if (assignment["statement_ref"], key) in selected else None
        binding = binding or old_bindings[key]
        resolved_bindings[binding["binding_ref"]] = binding
        changed.append(dict(assignment, binding_ref=binding["binding_ref"]))
    impact = _impact(refs, [old_bindings[b] for s, b in selected if s in refs], facts)
    result = _result(adopted, adopted["identity_revision"], operation_ref, changed,
                     list(resolved_bindings.values()), refs, review_resolutions=[resolution],
                     adopted_constraints=adopted_policies, definition_aliases=aliases)
    result["definition_changes"] = changes
    return _plan(adopted, snapshot, result, [fresh["basis_version"], intent, decision_ref, operation_ref, actor_ref],
                 before, dict(action=action, changed_bindings=list(new_bindings.values()),
                              adopted_constraints=adopted_policies, definition_aliases=aliases), impact)


def plan_inheritance(store, adopted, target_identity_revision, affected_statement_refs, *,
                     operation_ref, target_identity=None, facts=()):
    """Carry unchanged ontology semantics across a scoped, program-owned identity delta."""
    library = adopted["library_ref"]
    require(_text(operation_ref) and _text(target_identity_revision)
            and target_identity_revision != adopted["identity_revision"], "ONTOLOGY_IDENTITY_TARGET_INVALID")
    refs = sorted(set(affected_statement_refs))
    old = load_identity(store, library, adopted["identity_revision"])
    new = target_identity if target_identity is not None else load_identity(store, library, target_identity_revision)
    require(new["library_ref"] == library and new["identity_revision"] == target_identity_revision,
            "ONTOLOGY_IDENTITY_TARGET_INVALID")
    changes = {}
    anchors = {}
    for statement_ref in refs:
        statement = old["statements"].get(statement_ref)
        require(statement and statement == new["statements"].get(statement_ref), "ONTOLOGY_IDENTITY_SOURCE_CHANGED")
        anchors[statement_ref] = digest(statement)
        for endpoint in statement["endpoints"]:
            occurrence_ref = endpoint["occurrence_ref"]
            before, after = (identity["bindings"].get(occurrence_ref) for identity in (old, new))
            require(before and after, "ONTOLOGY_IDENTITY_BINDING_MISSING")
            if before["entity_ref"] != after["entity_ref"]:
                changes[occurrence_ref] = dict(occurrence_ref=occurrence_ref, before=before["entity_ref"],
                                               after=after["entity_ref"])
    snapshot = OntologyRepository(store).snapshot(library, adopted["ontology_revision"])
    assignments = _scoped(snapshot, refs)
    keys = {row["binding_ref"] for row in assignments}
    bindings = [row for row in snapshot["bindings"] if row["binding_ref"] in keys]
    dependencies = [changes[k] for k in sorted(changes)]
    impact = _impact(refs, bindings, facts)
    result = _result(adopted, target_identity_revision, operation_ref, assignments, bindings, refs,
                     identity_dependency_changes=dependencies, inherited_statement_sha256=anchors)
    return _plan(adopted, snapshot, result, [adopted["view_revision"], target_identity_revision, operation_ref,
                                            anchors, dependencies],
                 dict(identity_revision=adopted["identity_revision"]),
                 dict(identity_revision=target_identity_revision, identity_dependency_changes=dependencies), impact)


def stage_plan(q, plan):
    """Persist the checked plan in the publisher's transaction without moving a head."""
    require(plan.get("contract") == PLAN and plan.get("plan_sha256") ==
            digest({k: v for k, v in plan.items() if k != "plan_sha256"}), "ONTOLOGY_PLAN_CORRUPTED")
    result = plan["result"]
    library, parent = result["library_ref"], plan["parent_ontology_revision"]
    parent_row = OntologyRepository._revision(q, library, parent)
    require(parent_row["identity_revision"] == plan["parent_identity_revision"], "ONTOLOGY_PLAN_PARENT_CHANGED")
    identity = q("""SELECT revision FROM identity_v1.revisions
                    WHERE library_ref=%s AND identity_revision=%s""",
                 [library, result["identity_revision"]]).fetchone()
    require(identity, "ONTOLOGY_PLAN_IDENTITY_MISSING")
    changes = result.get("identity_dependency_changes", [])
    if changes:
        observed = q("""SELECT DISTINCT ON (occurrence_ref) occurrence_ref,entity_ref
                       FROM identity_v1.bindings
                       WHERE library_ref=%s AND revision<=%s AND occurrence_ref=ANY(%s)
                       ORDER BY occurrence_ref,revision DESC""",
                     [library, identity["revision"], [row["occurrence_ref"] for row in changes]]).fetchall()
        require({row["occurrence_ref"]: row["entity_ref"] for row in observed} ==
                {row["occurrence_ref"]: row["after"] for row in changes}, "ONTOLOGY_PLAN_IDENTITY_CHANGED")
    anchors = result.get("inherited_statement_sha256", {})
    if anchors:
        observed = q("""SELECT statement_ref,payload FROM identity_v1.statements
                       WHERE library_ref=%s AND first_revision<=%s AND statement_ref=ANY(%s)""",
                     [library, identity["revision"], list(anchors)]).fetchall()
        require({row["statement_ref"]: digest(row["payload"]) for row in observed} == anchors,
                "ONTOLOGY_PLAN_SOURCE_CHANGED")
    require(plan["routing_bundle"]["result"] == result and result["target_ontology_revision"] ==
            ref("ontology_revision", [parent, plan["input_sha256"],
                {k: v for k, v in result.items() if k != "target_ontology_revision"}]), "ONTOLOGY_PLAN_RESULT_CHANGED")
    return OntologyRepository.save_in_transaction(q, result, parent, plan["input_sha256"], [])
