"""Prepare fact changes from authenticated material and complete affected-group snapshots."""

from collections import defaultdict
from copy import deepcopy

from . import BUNDLE, RESULT, RULE_VERSION, ref, require, seal
from .input import load_inputs
from .normalization import OpenStatement, assertion_key, normalize_assertion
from .reviews import review_proposals

EMPTY_BASE = dict(head=dict(activation_seq=0, activation_ref=None), versions=[], support_links=[])


def _version_id(version):
    return version["fact_version_id"]


def _outcome(statement_ref, kind, rule, fact_refs=(), warnings=()):
    return dict(statement_ref=statement_ref, routing_result=kind, rule_ref=f"routing_rule_{rule}_v1",
                fact_refs=list(fact_refs), support_statement_refs=[statement_ref], review_refs=[],
                warnings=list(warnings))


def group_keys_for(request, ontology_bundle, statements):
    """Calculate indexed read keys before the Rust call. Also load old groups by statement_ref."""
    _, definitions, bindings, assignments, constraints = load_inputs(request, ontology_bundle, statements)
    keys = set()
    for statement_ref in request["statement_refs"]:
        row = statements.get(statement_ref)
        assignment = assignments.get(statement_ref, {})
        binding = bindings.get(assignment.get("binding_ref"), {})
        definition = definitions.get(binding.get("definition_ref"))
        if row and definition and binding.get("binding_state") == "BOUND":
            try:
                prepared = normalize_assertion(row, definition, binding, request, constraints)
            except OpenStatement:
                continue
            keys.add(prepared["assertion"]["state_group"]["key"])
    return sorted(keys)


def fold_plan(base, plan):
    closed = {item["fact_version_id"] for item in plan["close_versions"]}
    versions = {item["fact_id"]: item for item in base["versions"] if _version_id(item) not in closed}
    versions.update({item["fact_id"]: item for item in plan["new_versions"]})
    links = {item["support_link_id"]: item for item in base["support_links"] if _version_id(item) not in closed}
    links.update({item["support_link_id"]: item for item in plan["add_supports"]})
    return versions, list(links.values())


def _targets(base, key):
    return {item["fact_version_id"]: item for item in base["versions"]
            if (item.get("state_group") or {}).get("key") == key}


def _revision_sources(item):
    for source in item["assertion"]["sources"]:
        source["kind"] = "SOURCE_REVISION"
    for support in item["supports"]:
        support["rust_source"]["kind"] = "SOURCE_REVISION"


def _update(item, base, unavailable):
    assertion = item["assertion"]
    statement = item["statement"]
    group = assertion["state_group"]["key"]
    evidence_refs = {row["source"].get("source_ref") for row in item["supports"]}
    evidence_refs.update(row["source"].get("unit_ref") for row in item["supports"])
    evidence_refs.discard(None)
    correction = statement.get("correction")
    if correction:
        target = correction.get("target_fact_version_ref")
        if target not in _targets(base, group) or target in unavailable or correction.get("evidence_ref") not in evidence_refs:
            raise OpenStatement("CORRECTION_TARGET_UNRESOLVED")
        unavailable.add(target)
        _revision_sources(item)
        return (dict(kind="CORRECT", target_version_id=target, assertion=assertion,
                     reason="EXPLICIT_SOURCE_CORRECTION"), "CORRECTION", "source_correction")
    handover = statement.get("handover")
    if handover:
        target = handover.get("target_fact_version_ref")
        if (target not in _targets(base, group) or handover.get("evidence_ref") not in evidence_refs
                or assertion["valid_time"]["kind"] != "STATE"):
            raise OpenStatement("HANDOVER_TARGET_UNRESOLVED")
        return (dict(kind="ANCHORED_HANDOVER", assertion=assertion, target_version_id=target,
                     reason="EXPLICIT_HANDOVER"), "COEXIST", "independent")
    authority = next((constraint for constraint in item["adopted_constraints"]
                      if constraint["kind"] == "SINGLE_VALUE" and constraint.get("authorize_succession")), None)
    if authority and assertion["valid_time"]["kind"] == "STATE" and not assertion["content"]["negated"] \
            and assertion["content"]["modality"] == "ASSERTED":
        return (dict(kind="STATE_CHANGE", assertion=assertion, authority="ONTOLOGY_SINGLE_VALUE",
                     reason="ADOPTED_SUCCESSION_RULE"), "COEXIST", "independent")
    return (dict(kind="ADD_FACT", assertion=assertion, reason="INDEPENDENT_ASSERTION"), "COEXIST", "independent")


def prepare_routing(request, ontology_bundle, statements, base, engine):
    """Pure preparation. The engine runs a fixed number of batch RPCs outside a write transaction."""
    request = deepcopy(request)
    ontology, definitions, bindings, assignments, constraints = load_inputs(request, ontology_bundle, statements)
    base = deepcopy(base)
    require(request["base_view_revision"] == base["head"]["activation_ref"], "FACT_BASE_STALE")
    gaps = list(request.get("gaps", []))
    if ontology.get("execution_status") in {"PARTIAL", "FAILED", "UNKNOWN_HOLD"}:
        gaps.append(dict(code="ONTOLOGY_EXECUTION_GAP", status=ontology["execution_status"]))
    outcomes, prepared, open_statements = {}, {}, {}
    local = request.get("local_domain_reroute")
    formerly_supported = {row.get("statement_ref") for row in base.get("supports", [])}
    detached = set()

    def leave_open(statement_ref, warning):
        if local and statement_ref in formerly_supported:
            require(warning in {"PROPERTY_UNINTERPRETED", "ONTOLOGY_REVIEW_DEPENDENCY"},
                    "FACT_LOCAL_ADOPTED_INTERPRETATION_UNAVAILABLE")
            detached.add(statement_ref)
        outcomes[statement_ref] = _outcome(statement_ref, "OPEN_UNINTERPRETED", "open", warnings=[warning])
        open_statements[statement_ref] = statements.get(statement_ref)

    for statement_ref in sorted(request["statement_refs"]):
        row = statements.get(statement_ref)
        assignment = assignments.get(statement_ref, {})
        binding = bindings.get(assignment.get("binding_ref"), {})
        try:
            if not row:
                gaps.append(dict(code="STATEMENT_MISSING", statement_ref=statement_ref))
                raise OpenStatement("STATEMENT_MISSING")
            if not assignment and statement_ref not in ontology["open_statement_refs"]:
                gaps.append(dict(code="ASSIGNMENT_MISSING", statement_ref=statement_ref))
                raise OpenStatement("ASSIGNMENT_MISSING")
            if assignment and not binding:
                gaps.append(dict(code="BINDING_MISSING", statement_ref=statement_ref))
                raise OpenStatement("BINDING_MISSING")
            if binding.get("binding_state") != "BOUND":
                raise OpenStatement("ONTOLOGY_REVIEW_DEPENDENCY" if binding.get("binding_state") == "NEEDS_REVIEW"
                                    else "PROPERTY_UNINTERPRETED")
            definition = definitions.get(binding["definition_ref"])
            if not definition:
                gaps.append(dict(code="DEFINITION_MISSING", statement_ref=statement_ref))
                raise OpenStatement("DEFINITION_MISSING")
            prepared[statement_ref] = normalize_assertion(row, definition, binding, request, constraints)
        except OpenStatement as error:
            leave_open(statement_ref, str(error))

    def normalize_input(time, hints):
        return dict(times=[time], timezone_hints=[{**hint, "time_index": 0} for hint in hints])

    normalization = []
    for statement_ref, item in prepared.items():
        statement = item["statement"]
        normalization.append((statement_ref, None,
                              normalize_input(item["assertion"]["valid_time"], statement.get("timezone_hints", []))))
        evidence = {row["source"].get(key) for row in item["supports"] for key in ("source_ref", "unit_ref")}
        evidence.discard(None)
        for option in statement.get("time_alternatives", []):
            if isinstance(option, dict) and option.get("world_time") and option.get("evidence_ref") in evidence:
                normalization.append((statement_ref, option, normalize_input(
                    option["world_time"], option.get("timezone_hints", []))))
    normalized = engine("normalize_routing_times", [row[2] for row in normalization]) if normalization else []
    require(len(normalized) == len(normalization), "FACT_RUST_NORMALIZE_INCOMPLETE")
    for (statement_ref, option, _), result in zip(normalization, normalized):
        item = prepared.get(statement_ref)
        if not item:
            continue
        if option is not None:
            if result.get("time") and result["time"] != item["assertion"]["valid_time"]:
                item.setdefault("time_alternatives", []).append({**option, "world_time": result["time"]})
            continue
        if not result.get("time"):
            leave_open(statement_ref, result.get("error", "TIME_UNINTERPRETED"))
            del prepared[statement_ref]
        else:
            item["assertion"]["valid_time"] = result["time"]
            item["warnings"].extend(warning["code"] for warning in result["warnings"])

    rust_base = {key: base[key] for key in EMPTY_BASE}
    metadata = dict(base.get("assertions", {}))
    base_versions = {version["fact_id"]: version for version in base["versions"]}
    keys = {(meta["assertion_key"], base_versions[fact_ref]["state_group"]["key"]): ("BASE", fact_ref)
            for fact_ref, meta in metadata.items() if fact_ref in base_versions and meta.get("assertion_key")}
    observed_sources = defaultdict(set)
    for fact_ref, version in base_versions.items():
        observed_sources[fact_ref].update(source["source_version_id"] for source in version["sources"]
                                          if source["role"] == "SUPPORT")
    version_to_fact = {_version_id(version): fact_ref for fact_ref, version in base_versions.items()}
    for link in base["support_links"]:
        if link["source"]["role"] == "SUPPORT":
            observed_sources[version_to_fact[link["fact_version_id"]]].add(link["source"]["source_version_id"])
    updates, decisions, policies, unavailable = [], {}, dict(base.get("policies", {})), set()
    alternatives = {}
    base_group_members = defaultdict(set)
    if local:
        for fact_ref, supports in base["supports_by_fact"].items():
            group_key = base_versions[fact_ref]["state_group"]["key"]
            base_group_members[group_key].update(row.get("statement_ref") for row in supports)
    # Corrections are resolved against exact base versions before support is attached.
    items = sorted(prepared.items(), key=lambda pair: (not pair[1]["statement"].get("correction"), pair[0]))
    for statement_ref, item in items:
        assertion = item["assertion"]
        group = assertion["state_group"]["key"]
        policies[group] = item["policy"]
        key = None if item.get("time_alternatives") else assertion_key(assertion, item["statement"])
        target = keys.get((key, group))
        if local and group in base_group_members and base["policies"][group] != item["policy"]:
            require(base_group_members[group] <= set(request["statement_refs"]),
                    "FACT_LOCAL_CONSTRAINT_SCOPE_INCOMPLETE")
            if target and target[0] == "BASE":
                target = None
        if target and not any(item["statement"].get(key) for key in ("correction", "handover")) and not (
                target[0] == "BASE" and _version_id(base_versions[target[1]]) in unavailable):
            if target[0] == "BASE":
                version = base_versions[target[1]]
                for source in assertion["sources"]:
                    if source["source_version_id"] in observed_sources[target[1]]:
                        continue
                    updates.append(dict(kind="ADD_SUPPORT", target_version_id=_version_id(version), source=source,
                                        reason="SAME_ASSERTION"))
            else:
                old_sources = updates[target[1]]["assertion"]["sources"]
                old_sources.extend(source for source in assertion["sources"] if source not in old_sources)
            decisions[statement_ref] = (*target, "SAME_ASSERTION", "same_assertion", key)
            continue
        try:
            update, outcome, rule = _update(item, rust_base, unavailable)
        except OpenStatement as error:
            leave_open(statement_ref, str(error))
            continue
        index = len(updates)
        if update["kind"] == "CORRECT":
            old = _targets(rust_base, group)[update["target_version_id"]]
            old_key = metadata.get(old["fact_id"], {}).get("assertion_key")
            keys.pop((old_key, group), None)
        if key:
            keys[key, group] = ("UPDATE", index)
        decisions[statement_ref] = ("UPDATE", index, outcome, rule, key)
        if item.get("time_alternatives") or update["kind"] == "CORRECT":
            alternatives[str(index)] = [row["world_time"] for row in item.get("time_alternatives", [])]
        updates.append(update)

    # A moved or reinterpreted statement stops supporting its previous
    # assertion. Independent statements still support the old assertion.
    support_owner = {row["rust_source"]["source_version_id"]: row for row in base.get("supports", [])}
    explicit_withdrawals = set(request.get("withdraw_source_version_refs", []))
    withdrawn_statement_refs = (set(ontology.get("withdrawn_statement_refs", [])) |
                                set(request.get("withdrawn_statement_refs", [])))
    require(not (withdrawn_statement_refs & decisions.keys()), "FACT_STATEMENT_WITHDRAWAL_CONFLICT")
    explicit_withdrawals.update(source for source, row in support_owner.items()
                                if row.get("statement_ref") in withdrawn_statement_refs)
    require(explicit_withdrawals <= support_owner.keys(), "FACT_WITHDRAW_SOURCE_UNAVAILABLE")
    if explicit_withdrawals:
        require(request["trigger"]["kind"] == "SOURCE_CHANGED", "FACT_WITHDRAW_SOURCE_TRIGGER_INVALID")
    for fact_ref, sources in sorted(observed_sources.items()):
        version_id = _version_id(base_versions[fact_ref])
        if version_id in unavailable:
            continue
        removed = []
        for source in sorted(sources):
            origin = support_owner.get(source, {})
            old_statement = origin.get("statement_ref")
            chosen = decisions.get(old_statement)
            moved = old_statement in detached or (chosen and chosen[:2] != ("BASE", fact_ref))
            withdrawn = source in explicit_withdrawals
            if moved or withdrawn:
                removed.append(source)
        if removed:
            if local:
                supports = base["supports_by_fact"].get(fact_ref, [])
                require(not any(row["rust_source"]["kind"] == "HUMAN_REVISION" for row in supports),
                        "FACT_LOCAL_HUMAN_ASSERTION_REBASE_REQUIRED")
                version = base_versions[fact_ref]
                require(not version.get("handover_predecessor")
                        and (version.get("derivation") or {}).get("authority") != "EXPLICIT_HANDOVER",
                        "FACT_LOCAL_EXPLICIT_HANDOVER_REBASE_REQUIRED")
            basis = dict(source_version_id=ref("fact_route_basis", [request["operation_ref"], removed]),
                         kind="SOURCE_REVISION", role="BACKGROUND")
            updates.append(dict(kind="WITHDRAW_SUPPORTS", target_version_id=version_id, source_version_ids=removed,
                                basis=basis, reason="SUPPORT_REASSIGNED_OR_WITHDRAWN"))

    rust_request = dict(prepare=dict(request_id=request["operation_ref"], library_id=request["library_ref"],
                                     base=rust_base, updates=updates), groups=policies,
                        base_time_alternatives=base_time_alternatives(base),
                        update_time_alternatives=alternatives)
    result = engine("prepare_fact_routing", rust_request)
    require(result.get("rule_version") == RULE_VERSION and len(result["update_fact_refs"]) == len(updates),
            "FACT_RUST_RULE_VERSION_MISMATCH")
    plan = result["plan"]
    versions, links = fold_plan(base, plan)
    source_rows = {row["rust_source"]["source_version_id"]: row for row in base.get("supports", [])}

    for statement_ref, (target, target_ref, outcome, rule, key) in decisions.items():
        fact_ref = target_ref if target == "BASE" else result["update_fact_refs"][target_ref]
        item = prepared[statement_ref]
        if outcome != "SAME_ASSERTION" or (local and target == "BASE"):
            definition, statement = item["definition"], item["statement"]
            metadata[fact_ref] = dict(
                assertion_key=key, definition_ref=definition["definition_ref"], property=definition["label"],
                subject_label=statement.get("subject_label"), binding_ref=item["binding"]["binding_ref"],
                constraint_refs=[constraint["constraint_ref"] for constraint in item["adopted_constraints"]],
                policy_candidates=item["policy_candidates"], time_alternatives=item.get("time_alternatives", []),
            )
        for support in item["supports"]:
            source_rows[support["rust_source"]["source_version_id"]] = {
                **support, "property_raw": item["statement"].get("property_raw"),
            }
        if outcome == "COEXIST" and any((version.get("derivation") or {}).get("successor_fact_id") == fact_ref
                                       for version in plan["new_versions"]):
            outcome, rule = "SUCCESSION", "authorized_succession"
        outcomes[statement_ref] = _outcome(statement_ref, outcome, rule, [fact_ref], item["warnings"])

    return assemble_bundle(request, base, result, rust_request, metadata, source_rows, outcomes, open_statements, gaps)


def base_time_alternatives(base):
    return {fact_ref: [row["world_time"] for row in meta["time_alternatives"]]
            for fact_ref, meta in base.get("assertions", {}).items() if meta.get("time_alternatives")}


def assemble_bundle(request, base, result, rust_request, metadata, source_rows, outcomes, open_statements, gaps,
                    review_overrides=None):
    plan = result["plan"]
    versions, links = fold_plan(base, plan)
    version_to_fact = {_version_id(version): fact_ref for fact_ref, version in versions.items()}
    supports = defaultdict(list)
    for fact_ref, version in versions.items():
        for source in version["sources"]:
            if source["role"] == "SUPPORT" and source["source_version_id"] in source_rows:
                supports[fact_ref].append(source_rows[source["source_version_id"]])
    for link in links:
        row = source_rows.get(link["source"]["source_version_id"])
        target = version_to_fact[link["fact_version_id"]]
        if link["source"]["role"] == "SUPPORT" and row and row not in supports[target]:
            supports[target].append(row)
    prior_reviews = {row["review_ref"]: row for row in base.get("reviews", [])}
    prior_reviews.update(base.get("review_overrides", {}))
    prior_reviews.update(review_overrides or {})
    reviews = review_proposals(result["conflicts"], versions, metadata, supports, request, prior_reviews)
    reviews_by_fact = defaultdict(list)
    for review in reviews:
        for side in review["sides"]:
            reviews_by_fact[side["fact_ref"]].append(review["review_ref"])
    contested = {ref for conflict in result["conflicts"] for ref in conflict["fact_refs"]}
    for outcome in outcomes.values():
        if not outcome["fact_refs"]:
            continue
        fact_ref = outcome["fact_refs"][0]
        outcome["support_statement_refs"] = sorted({row["statement_ref"] for row in supports[fact_ref] if row.get("statement_ref")})
        outcome["review_refs"] = sorted(reviews_by_fact[fact_ref])
        if outcome["review_refs"] and outcome["routing_result"] in {"COEXIST", "SUCCESSION"}:
            outcome["routing_result"] = "CONFLICT_REVIEW"
            outcome["rule_ref"] = "routing_rule_definite_conflict_v1"
        elif fact_ref in contested and not outcome["review_refs"]:
            outcome["warnings"].append("CONTESTED_WITHOUT_ACTIONABLE_EVIDENCE")
    for fact_ref in versions:
        metadata[fact_ref] = {**metadata[fact_ref], "state": "CONTESTED" if fact_ref in contested else "ADOPTED"}

    group_keys = {row["key"] for row in plan["affected_group_digests"]}
    group_keys.update(key for key in base.get("affected_group_keys", []))
    return seal(dict(
        contract=BUNDLE, rule_version=RULE_VERSION, request=request,
        result=dict(
            contract=RESULT, library_ref=request["library_ref"], operation_ref=request["operation_ref"],
            base_view_revision=request["base_view_revision"], execution_status="PARTIAL" if gaps else "COMPLETED",
            coverage="PARTIAL" if gaps else "FULL", statement_results=[outcomes[key] for key in sorted(outcomes)],
            gaps=gaps, counts=dict(input_statements=len(request["statement_refs"]), accounted_statements=len(outcomes),
                                   standard_facts=len(versions), open_statements=len(open_statements),
                                   contested_facts=len(contested),
                                   open_reviews=sum(review["review_status"] == "OPEN" for review in reviews)),
        ),
        rust=dict(input=rust_request, output=result), assertions={key: metadata[key] for key in versions},
        supports={key: supports[key] for key in versions}, reviews=reviews, open_statements=open_statements,
        affected_group_keys=sorted(group_keys), base_group_digests=base.get("group_digests", {}),
    ))
