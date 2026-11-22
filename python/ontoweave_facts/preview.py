"""Prepare local domain changes for the shared publisher's preview and decision lifecycle."""

from copy import deepcopy

from . import INPUT, RULE_VERSION, digest, ref, require
from .normalization import _group_policy, assertion_key, group_content, normalize_value
from .routing import EMPTY_BASE, assemble_bundle, base_time_alternatives, fold_plan


def _check_review(review, base, intent):
    require(review["review_status"] == "OPEN", "FACT_REVIEW_NOT_OPEN")
    actual = next((stored for stored in base["reviews"] if stored["review_ref"] == review["review_ref"]), None)
    actual = base.get("review_overrides", {}).get(review["review_ref"], actual)
    require(actual and actual["basis_version"] == review["basis_version"] and actual["review_status"] == "OPEN",
            "FACT_REVIEW_BASIS_STALE")
    require(set(review["basis"]["fact_version_refs"]) <= {row["fact_version_id"] for row in base["versions"]},
            "FACT_REVIEW_BASIS_STALE")
    require(intent.get("kind") in {action["kind"] for action in review["available_actions"]} - {"DEFER"}
            and isinstance(intent.get("reason"), str) and bool(intent["reason"].strip()), "FACT_INTENT_INVALID")


def _target(base, review, intent):
    requested = intent.get("target_fact_version_ref")
    require(requested in review["basis"]["fact_version_refs"], "FACT_INTENT_TARGET_INVALID")
    return next(row for row in base["versions"] if row["fact_version_id"] == requested)


def _assertion(version):
    return dict(content=deepcopy(version["content"]), valid_time=version["asserted_valid_time"],
                state_group=deepcopy(version["state_group"]), sources=[])


def _scope(assertion, library, meta, proposed_scope):
    require(isinstance(proposed_scope, list) and all(isinstance(pair, list) and len(pair) == 2
            and isinstance(pair[0], str) and pair[0] and pair[1] is not None for pair in proposed_scope),
            "FACT_INTENT_SCOPE_INVALID")
    content = assertion["content"]
    content["conditions"]["scope"] = sorted(proposed_scope, key=digest)
    records = {row["constraint_ref"]: row for row in meta.get("policy_candidates", [])}
    adopted, policy = _group_policy({"constraint_refs": list(records)}, content["conditions"]["scope"],
                                    records, records.keys(), opaque=bool(content["conditions"].get("opaque_qualifiers")))
    group = group_content(library, content, policy)
    assertion["state_group"] = dict(key=group, single_valued=policy["unique_subject"])
    return group, adopted, policy


def _edited_assertion(version, meta, review, intent, library):
    assertion = _assertion(version)
    if intent["kind"] == "REVISE_SCOPE":
        proposed_scope = intent.get("proposed_scope")
    else:
        edit = intent.get("proposed_content")
        require(isinstance(edit, dict) and bool(edit) and edit.keys() <= {"value", "negated"}
                and ("negated" not in edit or isinstance(edit["negated"], bool)), "FACT_INTENT_CONTENT_INVALID")
        if "value" in edit:
            old_kind = assertion["content"]["value"]["kind"]
            replacement = edit["value"]
            require(isinstance(replacement, dict) and replacement.get("kind") == old_kind,
                    "FACT_INTENT_VALUE_INVALID")
            if old_kind == "ENTITY":
                require(any(replacement == side["value"] and side["definition_ref"] == meta["definition_ref"]
                            for side in review["sides"]), "FACT_INTENT_VALUE_REQUIRES_IDENTITY_REVIEW")
            else:
                replacement = normalize_value(replacement, {}, old_kind)
            edit = {**edit, "value": replacement}
        assertion["content"].update(edit)
        proposed_scope = assertion["content"]["conditions"]["scope"]
    group, adopted, policy = _scope(assertion, library, meta, proposed_scope)
    return assertion, group, adopted, policy


def intent_group_keys(review, intent, base, library):
    _check_review(review, base, intent)
    keys = set(review["impact"]["group_keys"])
    if intent["kind"] in {"REVISE_SCOPE", "CORRECT_FACT"}:
        version = _target(base, review, intent)
        _, group, _, _ = _edited_assertion(version, base["assertions"][version["fact_id"]], review, intent, library)
        keys.add(group)
    return sorted(keys)


def _basis(review, intent, decision_ref, actor_ref, extra_sources):
    all_evidence = {row["source_ref"]: row for side in review["sides"] for row in side["evidence"]}
    all_evidence.update(extra_sources)
    refs = intent.get("evidence_refs", [])
    require(isinstance(refs, list) and bool(refs) and all(value in all_evidence for value in refs),
            "FACT_INTENT_EVIDENCE_INVALID")
    evidence = [all_evidence[key] for key in sorted(set(refs))]
    source = dict(source_version_id=ref("fact_human_evidence", [decision_ref, actor_ref, evidence]),
                  kind="HUMAN_REVISION", role="SUPPORT")
    record = dict(statement_ref=None, rust_source=source,
                  source=dict(source_ref=source["source_version_id"], precision="HUMAN_REVISION",
                              decision_ref=decision_ref, actor_ref=actor_ref, evidence=evidence), reason=intent["reason"])
    return source, record


def preview_fact_intent(review, intent, base, request, engine, *, decision_ref, actor_ref, extra_sources=None):
    """Build a read-only preview and staged bundle. The publisher binds and verifies the public envelope."""
    require(request.get("contract") == INPUT and request.get("trigger", {}).get("kind") == "HUMAN_DECISION"
            and request["base_view_revision"] == base["head"]["activation_ref"]
            and not request["statement_refs"] and bool(decision_ref) and bool(actor_ref), "FACT_PREVIEW_INPUT_INVALID")
    require(review["review_ref"] in request["trigger"]["refs"], "FACT_PREVIEW_TARGET_MISMATCH")
    wanted = intent_group_keys(review, intent, base, request["library_ref"])
    require(set(wanted) <= set(base["affected_group_keys"]), "FACT_PREVIEW_GROUP_SNAPSHOT_INCOMPLETE")
    metadata = deepcopy(base["assertions"])
    policies = deepcopy(base["policies"])
    source_rows = {row["rust_source"]["source_version_id"]: row for row in base["supports"]}
    updates = []
    kind = intent["kind"]
    if kind != "KEEP_BOTH":
        target = _target(base, review, intent)
        target_ref = target["fact_version_id"]
        basis, record = _basis(review, intent, decision_ref, actor_ref, extra_sources or {})
        source_rows[basis["source_version_id"]] = record
        reason = intent["reason"]
        if kind == "WITHDRAW_FACT":
            update = dict(kind="WITHDRAW", target_version_id=target_ref, basis=basis, reason=reason)
            if intent.get("source_version_ref"):
                update.update(kind="WITHDRAW_SUPPORT", source_version_id=intent["source_version_ref"])
        elif kind in {"CLOSE_STATE", "RETIME_FACT"}:
            proposed = deepcopy(intent.get("proposed_world_time"))
            require(isinstance(proposed, dict), "FACT_INTENT_TIME_INVALID")
            if kind == "CLOSE_STATE":
                current = target["asserted_valid_time"]
                require(current["kind"] == proposed.get("kind") == "STATE"
                        and proposed.get("end", {}).get("kind") == "EXACT"
                        and proposed["end"].get("point", {}).get("value"), "FACT_INTENT_CLOSE_INVALID")
                require(not proposed.get("start") or all(
                    proposed["start"].get(key) == (current["start"] or {}).get(key) for key in ("value", "precision")),
                    "FACT_INTENT_CLOSE_START_CHANGED")
                proposed["start"] = current["start"]
            update = dict(kind="AMEND_TIME", target_version_id=target_ref,
                          valid_time=proposed, basis=basis, reason=reason)
        else:
            meta = metadata[target["fact_id"]]
            assertion, group, adopted, policy = _edited_assertion(target, meta, review, intent, request["library_ref"])
            assertion["sources"] = [basis]
            policies[group] = policy
            meta["constraint_refs"] = [row["constraint_ref"] for row in adopted]
            update = dict(kind="CORRECT", target_version_id=target_ref, assertion=assertion, reason=reason)
        updates.append(update)

    alternatives = base_time_alternatives(base)
    if kind in {"CLOSE_STATE", "RETIME_FACT"}:
        alternatives.pop(target["fact_id"], None)
        metadata[target["fact_id"]]["time_alternatives"] = []
    rust_base = {key: base[key] for key in EMPTY_BASE}
    rust_request = dict(prepare=dict(request_id=request["operation_ref"], library_id=request["library_ref"],
                                     base=rust_base, updates=updates), groups=policies, base_time_alternatives=alternatives)
    result = engine("prepare_fact_routing", rust_request)
    require(result["rule_version"] == RULE_VERSION, "FACT_RUST_RULE_VERSION_MISMATCH")
    plan = result["plan"]
    versions_before = {row["fact_id"]: row for row in base["versions"]}
    versions_after, _ = fold_plan(base, plan)
    if updates and kind != "WITHDRAW_FACT":
        revised = versions_after[target["fact_id"]]
        metadata[target["fact_id"]]["assertion_key"] = assertion_key(
            dict(content=revised["content"], valid_time=revised["asserted_valid_time"]),
            revised["content"]["conditions"])
    override = {review["review_ref"]: {**review, "review_status": "DECIDED", "decision_ref": decision_ref}}
    bundle = assemble_bundle(request, base, result, rust_request, metadata, source_rows, {}, {}, [], override)
    # Other conflicts newly introduced by the change remain distinct actionable matters.
    added = sorted(versions_after.keys() - versions_before.keys())
    removed = sorted(versions_before.keys() - versions_after.keys())
    updated = sorted(fact_ref for fact_ref in versions_after.keys() & versions_before.keys()
                     if versions_after[fact_ref] != versions_before[fact_ref] or
                     bundle["assertions"][fact_ref]["state"] != base["assertions"][fact_ref]["state"])
    affected = sorted(set(added + removed + updated) | {side["fact_ref"] for side in review["sides"]})
    return dict(
        contract="ontoweave-fact-intent-preview/1", review_ref=review["review_ref"], basis_version=review["basis_version"],
        base_view_revision=request["base_view_revision"],
        before=[versions_before[key] for key in affected if key in versions_before],
        after=[versions_after[key] for key in affected if key in versions_after],
        impact=dict(check_status="CHECKED_FACT_GROUPS", affected_fact_refs=affected, group_keys=wanted,
                    expected_fact_projection=dict(added=added, updated=updated, removed=removed),
                    review_status_transition={"from": "OPEN", "to": "DECIDED"},
                    graph_index_status="PUBLISHER_PROJECTION_REQUIRED"),
        bundle=bundle,
    )
