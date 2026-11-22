"""Durable human decisions with optimistic preview binding and reversible groups."""

from datetime import timedelta

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require

from .input import ref, source_key
from .matching import Groups, profile_views
from .publication import _receipt, stage_job
from .storage import (bindings_at, check_base, create_revision, decisions_at, insert_decision, library_lock,
                      revision_at, source_state, update_bindings)

ACTIONS = {"SAME", "DIFFERENT", "CORRECT_AND_MERGE", "REVERT", "DEFER"}
IMPACT_KEYS = ("declared_constraint_collisions", "identity_constraints", "adopted_derivations",
               "citation_dependencies")


def _plan(action, request, groups):
    require(action in ACTIONS, "IDENTITY_ACTION_UNKNOWN")
    events = {e["decision_ref"]: e for e in groups.events}
    if action == "REVERT":
        event = events.get(request.get("target_decision_ref"))
        require(event and event["action"] == "SAME", "IDENTITY_REVERT_TARGET_INACTIVE")
        return event["left_ref"], event["right_ref"], [event["decision_ref"]]
    left, right = sorted((request["left_ref"], request["right_ref"]))
    require(left != right and left in groups.members and right in groups.members,
            "IDENTITY_PAIR_NOT_LIVE")
    constraints = sorted(event["decision_ref"] for event in groups.constraints(left, right))
    if action == "CORRECT_AND_MERGE":
        require(constraints and constraints == sorted(request.get("supersedes", [])),
                "IDENTITY_CORRECTION_MUST_IDENTIFY_CONSTRAINTS")
        require(isinstance(request.get("reason"), str) and request["reason"].strip(),
                "IDENTITY_CORRECTION_REASON_REQUIRED")
    if action != "CORRECT_AND_MERGE":
        require(not request.get("supersedes"), "IDENTITY_SUPERSEDES_REQUIRES_CORRECTION")
    return left, right, constraints if action == "CORRECT_AND_MERGE" else []


def _impact(active, a, b, groups, occurrences, statements, extra_checks):
    current = sorted({groups.representative[e] for e in (a, b)})
    members = set().union(*(groups.members[e] for e in current))
    affected = [o for o in occurrences.values() if o["home_entity_ref"] in members]
    fact_refs = sorted({s for o in affected for s in o["statement_refs"]})
    source_refs = {source_key(s) for o in affected for s in o["source_refs"] if s["precision"] == "UNIT"}
    current_map = {key: groups.representative[o["home_entity_ref"]] for key, o in occurrences.items()}
    index_entities = set(current)
    for s in fact_refs:
        index_entities.update(current_map[e["occurrence_ref"]] for e in statements[s]["endpoints"])
    raw_differences = sorted({(statements[s]["candidate"].get("predicate") or "",
                               statements[s]["candidate"].get("value_kind") or "",
                               statements[s]["candidate"].get("value_raw") or "") for s in fact_refs})
    checks = dict(
        declared_constraint_collisions=dict(status="NOT_CONFIGURED", refs=[]),
        identity_constraints=dict(status="READY", refs=[d["decision_ref"] for d in groups.constraints(a, b)]),
        adopted_derivations=dict(status="EMPTY_BASE" if active is None else "NOT_CONFIGURED", refs=[]),
        citation_dependencies=dict(status="EMPTY_BASE" if active is None else "NOT_CONFIGURED", refs=[]),
    )
    scope = dict(entity_refs=current, home_entity_refs=sorted(members), statement_refs=fact_refs,
                 source_refs=[list(key) for key in sorted(source_refs)], index_entity_refs=sorted(index_entities))
    if extra_checks:
        try:
            provided = extra_checks(scope)
            require(set(provided) <= set(IMPACT_KEYS) - {"identity_constraints"}
                    and all(v["status"] == "READY" and isinstance(v["refs"], list) for v in provided.values()),
                    "IDENTITY_IMPACT_RECEIPT_INVALID")
            checks.update(provided)
        except Exception as exc:
            for k in set(IMPACT_KEYS) - {"identity_constraints"}:
                checks[k] = dict(status="READ_FAILED", refs=[], code=getattr(exc, "code", None) or type(exc).__name__)
    return dict(scope=scope, counts=dict(nodes=len(current), statements=len(fact_refs), sources=len(source_refs),
                                       index_documents=len(index_entities)),
                checks=checks, differences=[list(v) for v in raw_differences],
                ontology_status="OPEN_UNINTERPRETED", time_status="OPEN_UNINTERPRETED")


def _base_request(active):
    return {f"base_{k}": active[k] if active else None for k in ("identity_revision", "view_revision")}


def preview_identity_decision(store, request, impact_reader=None):
    library = request["library_ref"]
    with store.transaction() as (q, _):
        head = library_lock(q, library)
        active = check_base(q, head, request)
        require(active, "IDENTITY_NO_ACTIVE_VIEW")
        homes, occurrences, statements = source_state(q, library, head["active_revision"])
        require(not head["pending_revision"], "IDENTITY_APPLICATION_PENDING")
        groups = Groups(set(homes.values()), decisions_at(q, library, head["active_revision"]))
        action = request["action"]
        left, right, supersedes = _plan(action, request, groups)
        history = {e["decision_ref"]: e for e in groups.events}
        profiles = profile_views({key: groups.representative[home] for key, home in homes.items()},
                                 occurrences, statements)
        impact = _impact(active, left, right, groups, occurrences, statements, impact_reader)
        now = q("SELECT clock_timestamp() AS ts").fetchone()["ts"]
        expires = now + timedelta(minutes=15)
        affected_members = set(impact["scope"]["home_entity_refs"])
        dependencies = [e["decision_ref"] for e in groups.events if e["action"] == "SAME"
                        and e["decision_ref"] not in supersedes
                        and {e["left_ref"], e["right_ref"]} & affected_members]
        prior = impact["checks"]["identity_constraints"]["refs"]
        sides = [profiles[groups.representative[entity]] for entity in (left, right)]
        review_rows = q("""SELECT payload FROM identity_v1.graph_rows g
                          WHERE library_ref=%s AND kind='REVIEW' AND revision<=%s AND payload IS NOT NULL
                            AND NOT EXISTS (
                              SELECT 1 FROM identity_v1.graph_rows n WHERE n.library_ref=g.library_ref
                                AND n.kind=g.kind AND n.row_ref=g.row_ref AND n.revision>g.revision AND n.revision<=%s)
                          ORDER BY row_ref""", [library, head["active_revision"], head["active_revision"]]).fetchall()
        current_pair = sorted(set(side["entity_ref"] for side in sides))
        related = [r["payload"] for r in review_rows
                   if [r["payload"]["current_left_ref"], r["payload"]["current_right_ref"]] == current_pair]
        result = dict(
            contract="ontoweave-identity-preview/1", library_ref=library, **_base_request(active),
            action=action, left_ref=left, right_ref=right, supersedes=supersedes,
            reason=request.get("reason"), target_decision_ref=request.get("target_decision_ref"),
            evidence=sides, relevant_reviews=related, impact=impact,
            previous_decisions=[history[r] for r in sorted(set(supersedes + prior))],
            dependent_decision_refs=dependencies, expires_at=expires.isoformat(),
            can_save=action != "SAME" or not prior,
        )
        if action == "REVERT":
            event = history[supersedes[0]]
            to_revert = supersedes + ([event["correction_event_ref"]] if event.get("correction_event_ref") else [])
            split = Groups(set(homes.values()), [*decisions_at(q, library, head["active_revision"]),
                           dict(action="REVERT", decision_ref="preview_revert", supersedes=to_revert)])
            result["restore_preview"] = dict(
                target_event=event, deactivated_events=to_revert,
                split_groups={e: split.representative[e] for e in sorted(affected_members)},
            )
        preview_ref = ref("identity_preview", result)
        result["preview_ref"] = preview_ref
        q("INSERT INTO identity_v1.previews VALUES(%s,%s,%s,%s)", [library, preview_ref, Jsonb(result), expires])
        return result


def _event(library, request_ref, action, left, right, **extra):
    decision_ref = ref("identity_decision", [library, request_ref])
    return dict(decision_ref=decision_ref, request_ref=request_ref, action=action,
                left_ref=left, right_ref=right, **extra)


def save_identity_decision(store, request, actor):
    library = request["library_ref"]
    request_ref = request["request_ref"]
    require(isinstance(actor, dict) and actor.get("actor_ref") and actor.get("kind") in ("HUMAN", "SYSTEM"),
            "IDENTITY_ACTOR_REQUIRED")
    require(isinstance(request_ref, str) and request_ref.strip(), "IDENTITY_REQUEST_REF_REQUIRED")
    with store.transaction() as (q, _):
        head = library_lock(q, library)
        active = revision_at(q, library, head["active_revision"])
        old = q("""SELECT revision,payload FROM identity_v1.decisions
                   WHERE library_ref=%s AND request_ref=%s""", [library, request_ref]).fetchone()
        if old:
            require(old["payload"].get("submitted_request") == request and old["payload"]["actor"] == actor,
                    "IDENTITY_REQUEST_REF_CONFLICT")
            job = q("SELECT status,payload FROM identity_v1.publication_jobs WHERE library_ref=%s AND revision=%s",
                    [library, old["revision"]]).fetchone()
            material = {}
            if job["status"] == "APPLIED":
                material = q("SELECT payload FROM identity_v1.active_views WHERE library_ref=%s AND revision=%s",
                             [library, old["revision"]]).fetchone()["payload"]
            return _receipt(job["payload"], job["status"], active,
                            failure=job["payload"].get("failure"), replay=True, **material)
        row = q("""SELECT payload,expires_at>clock_timestamp() AS fresh FROM identity_v1.previews
                    WHERE library_ref=%s AND preview_ref=%s""", [library, request["preview_ref"]]).fetchone()
        require(row, "IDENTITY_PREVIEW_UNKNOWN")
        require(row["fresh"], "IDENTITY_PREVIEW_EXPIRED")
        preview = row["payload"]
        require(request["action"] == preview["action"], "IDENTITY_PREVIEW_ACTION_CHANGED")
        check_base(q, head, preview)
        require(not head["pending_revision"], "IDENTITY_APPLICATION_PENDING")
        action = preview["action"]
        if action == "DEFER":
            return dict(decision_status="DEFERRED", application_status="UNCHANGED",
                        active_view_revision=active["view_revision"])
        require(actor["kind"] == "HUMAN", "IDENTITY_HUMAN_CONFIRMATION_REQUIRED")
        require(preview["can_save"], "IDENTITY_GROUP_DIFFERENT_CONSTRAINT")
        homes, occurrences, statements = source_state(q, library, head["active_revision"])
        history = decisions_at(q, library, head["active_revision"])
        groups = Groups(set(homes.values()), history)
        left, right, supersedes = _plan(action, preview, groups)
        actual = "SAME" if action == "CORRECT_AND_MERGE" else action
        event = _event(library, request_ref, actual, left, right,
                       operation=action, actor=actor, reason=preview.get("reason"),
                       supersedes=supersedes, preview_ref=preview["preview_ref"], submitted_request=request)
        events = [event]
        if action == "CORRECT_AND_MERGE":
            replace = _event(library, request_ref + ":supersede", "SUPERSEDE", left, right,
                             actor=actor, reason=preview["reason"], supersedes=supersedes,
                             preview_ref=preview["preview_ref"])
            event["supersedes"] = []
            event["correction_event_ref"] = replace["decision_ref"]
            # Reverting the corrective merge restores the earlier decision too.
            replace["paired_merge_ref"] = event["decision_ref"]
            events.insert(0, replace)
        elif action == "REVERT":
            old_event = next(e for e in history if e["decision_ref"] == supersedes[0])
            if old_event.get("correction_event_ref"):
                event["supersedes"] = [*supersedes, old_event["correction_event_ref"]]
        new_groups = Groups(set(homes.values()), [*history, *events])
        revision = create_revision(q, head, [event["decision_ref"]])
        for ordinal, decision in enumerate(events):
            insert_decision(q, library, revision["revision"], decision, ordinal)
        previous = bindings_at(q, library, head["active_revision"])
        updates = update_bindings(q, library, revision["revision"], homes, new_groups, previous)
        declared = preview["impact"]["checks"]["declared_constraint_collisions"]
        rules = dict(declared_constraint_refs=declared["refs"],
                     ontology_revision=declared.get("ontology_revision"),
                     time_interpretation_revision=declared.get("time_interpretation_revision"))
        return stage_job(q, revision, [d["decision_ref"] for d in events], previous, updates, occurrences,
                         statements, review_entities=preview["impact"]["scope"]["entity_refs"], rule_context=rules)
