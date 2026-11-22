"""Plan identity reviews against a confirmed compound view. Persistence belongs to the publisher."""

from copy import deepcopy
from math import isfinite

from ontoweave_facts.repository import _prior_groups
from ontoweave_ontology.signatures import source_ref
from ontoweave_publication.store import assert_base, digest, head, manifest, projection, ref, require

from .adoption import REASONS
from .agent import JUDGMENT_CONTRACT, _excerpt, _fact_location
from .decisions import _event, _impact, _plan
from .input import ref as identity_ref
from .matching import Groups, profile_views
from .publication import _live_reviews
from .storage import bindings_at, decisions_at, reviews_at, source_state

CHANGE_CONTRACT = "ontoweave-identity-change-bundle/1"
ACTIONS = {"MERGE": "SAME", "KEEP_SEPARATE": "DIFFERENT"}
LABELS = {"MERGE": "合并为同一实体", "KEEP_SEPARATE": "保持为不同实体", "DEFER": "暂不处理"}


def _required_action(kind):
    return dict(kind=kind, label=LABELS[kind], required_fields=["reason"])


def _evidence(source, statement, occurrence):
    text = source["text"]
    excerpt_range = preview = None
    position, exact = _fact_location(text, statement) if statement else (None, False)
    if exact:
        _, start, end = _excerpt(text, [], focus=position)
        preview = text[start:end]
        excerpt_range = dict(start=start, end=end, coordinate="UNIT_CODEPOINTS")
    return dict(source_ref=source_ref(source), statement_ref=statement["statement_ref"] if statement else None,
                occurrence_ref=occurrence["occurrence_ref"], precision=source["precision"],
                location=source, preview=preview, source_excerpt_range=excerpt_range, text=text,
                statement_excerpt=statement["record"] if statement else None)


def _review_side(profile, occurrences, statements):
    evidence = {}
    for key in profile["occurrences"]:
        occurrence = occurrences[key]
        linked = [statements[s] for s in occurrence["statement_refs"]]
        for statement in linked or [None]:
            sources = statement["source_refs"] if statement else occurrence["source_refs"]
            for source in sources:
                if source["precision"] == "UNIT" and source.get("text"):
                    item = _evidence(source, statement, occurrence)
                    evidence[item["source_ref"], item["statement_ref"], key] = item
    evidence = list(evidence.values())
    return dict(entity_ref=profile["entity_ref"], label=profile["display_name"], subject=profile["display_name"],
                names=profile["names"], aliases=profile["aliases"], types=profile["type_observations"],
                occurrence_refs=profile["occurrences"], statement_refs=profile["statement_refs"],
                candidate_refs=sorted({statements[k]["candidate_ref"] for k in profile["statement_refs"]}),
                evidence=evidence, source_refs=sorted({e["source_ref"] for e in evidence}))


def _model_suggestion(review):
    answer = review.get("judgment") or {}
    contract, judgment = answer.get("contract"), answer.get("judgment")
    status, score = answer.get("confidence_status"), answer.get("confidence")
    if contract != JUDGMENT_CONTRACT:
        status = "LEGACY_UNSCORED" if judgment else "NOT_APPLICABLE"
    elif status not in {"VALID", "MISSING", "INVALID"}:
        status = "NOT_APPLICABLE"
    if status == "VALID" and (type(score) not in (int, float) or not isfinite(score) or not 0 <= score <= 1):
        status = "INVALID"
    return dict(judgment=judgment, confidence=score if status == "VALID" else None,
                confidence_status=status, reason=answer.get("reason"),
                evidence_refs=answer.get("evidence_refs", []), contract=contract)


def _adoption(review):
    if review.get("adoption_details"):
        return review["adoption_details"]
    reason = review.get("adoption")
    status = "NOT_EVALUATED"
    if review["status"] == "TECHNICAL_PENDING":
        status = "TECHNICAL_PENDING"
    elif reason:
        status = "NOT_APPLIED"
    return dict(status=status, reason_code=reason, reason=REASONS.get(reason),
                impact=review.get("adoption_impact"), policy=None)


def _review_actions(review, sides, adoption):
    actions = [_required_action("DEFER")]
    if adoption["status"] == "TECHNICAL_PENDING":
        return actions, dict(status="TECHNICAL_PENDING", actionable=False,
                             reason_code=adoption["reason_code"] or "TECHNICAL_PENDING",
                             reason=adoption["reason"] or "技术检查尚未完成。")
    if not all(any(item["statement_ref"] and item["statement_excerpt"] for item in side["evidence"])
               for side in sides):
        return actions, dict(status="WAITING_FOR_EVIDENCE", actionable=False,
                             reason_code="IDENTITY_BILATERAL_MATERIAL_UNAVAILABLE",
                             reason="双方的具体陈述及来源材料还未齐备。")
    if not review["blocking_decision_refs"]:
        actions.insert(0, _required_action("MERGE"))
    actions.insert(-1, _required_action("KEEP_SEPARATE"))
    return actions, dict(status="ACTIONABLE", actionable=True, reason_code=None, reason=None)


def _identity_snapshot(q, library, revision):
    row = q("""SELECT revision FROM identity_v1.revisions WHERE library_ref=%s AND identity_revision=%s""",
            [library, revision]).fetchone()
    require(row, "IDENTITY_PUBLICATION_BASIS_UNKNOWN", 409)
    number = row["revision"]
    homes, occurrences, statements = source_state(q, library, number)
    history = decisions_at(q, library, number)
    bindings = bindings_at(q, library, number)
    return dict(library_ref=library, identity_revision=revision, sequence=number,
                homes=homes, occurrences=occurrences, statements=statements, bindings=bindings,
                history=history, reviews=reviews_at(q, library, number))


def _reviews(snapshot, groups):
    live = _live_reviews(snapshot["reviews"], groups)
    if not live:
        return {}
    occurrences, statements = snapshot["occurrences"], snapshot["statements"]
    profiles = profile_views({k: groups.representative[home] for k, home in snapshot["homes"].items()},
                             occurrences, statements)
    rows = {}
    for review_ref, review in live.items():
        entity_refs = [review["current_left_ref"], review["current_right_ref"]]
        if not all(entity in profiles for entity in entity_refs):
            continue
        sides = [_review_side(profiles[entity], occurrences, statements) for entity in entity_refs]
        evidence = [item for side in sides for item in side["evidence"]]
        source_refs = sorted({item["source_ref"] for item in evidence})
        suggestion = _model_suggestion(review)
        adoption = _adoption(review)
        actions, eligibility = _review_actions(review, sides, adoption)
        basis = dict(entity_refs=entity_refs, source_snapshot_sha256=review["evidence_sha256"], sides=sides)
        rows[review_ref] = dict(
            review_ref=review_ref, review_kind="IDENTITY", target_kind="IDENTITY", review_status="OPEN",
            basis_sha256=digest(basis),
            entity_refs=entity_refs, sides=sides, evidence=evidence, source_refs=source_refs,
            subject=" / ".join(side["label"] for side in sides), title="核对两条记录中的实体身份",
            reason=(review.get("judgment") or {}).get("reason") or "关联来源的对象身份需要确认",
            identity_status=review["status"], judgment=review.get("judgment"),
            model_suggestion=suggestion, adoption=adoption, review_eligibility=eligibility,
            blocking_decision_refs=review["blocking_decision_refs"], available_actions=actions,
        )
    return rows


def identity_review_projection(q, library, identity_revision):
    """Project shared review cards from an explicit saved identity revision."""
    snapshot = _identity_snapshot(q, library, identity_revision)
    return _reviews(snapshot, Groups(set(snapshot["homes"].values()), snapshot["history"]))


def overlay_review_projection(q, library, bundle):
    """Prepare successor review rows for an unpublished identity overlay."""
    verify_change_bundle(bundle)
    require(library == bundle["library_ref"], "IDENTITY_CHANGE_OVERLAY_BASIS_MISMATCH")
    snapshot = _identity_snapshot(q, library, bundle["base_identity_revision"])
    event = dict(bundle["identity_event"], stored_revision=snapshot["sequence"] + 1)
    history = [*snapshot["history"], event]
    groups = Groups(set(snapshot["homes"].values()), history)
    return _reviews(dict(snapshot, identity_revision=bundle["target_identity_revision"]), groups)


def _seal(body):
    return dict(body, body_sha256=digest(body), bundle_ref=ref("identity_change", body))


def verify_change_bundle(bundle):
    body = {k: v for k, v in bundle.items() if k not in {"body_sha256", "bundle_ref"}}
    require(bundle.get("contract") == CHANGE_CONTRACT and _seal(body) == bundle,
            "IDENTITY_CHANGE_BUNDLE_INVALID", 422)
    return bundle


def _binding_updates(snapshot, groups):
    updates = {}
    for occurrence, home in snapshot["homes"].items():
        previous = snapshot["bindings"].get(occurrence)
        require(previous, "IDENTITY_OCCURRENCE_NOT_MAPPED", 503)
        next_row = dict(occurrence_ref=occurrence, entity_ref=groups.representative[home],
                        decision_ref=groups.provenance.get(home))
        if previous != next_row:
            updates[occurrence] = dict(previous=previous, next=next_row)
    return updates


def overlay_identity(identity, bundle):
    """Immutable successor snapshot for the publisher's in-memory projection and routing adapters."""
    verify_change_bundle(bundle)
    require(identity["library_ref"] == bundle["library_ref"]
            and identity["identity_revision"] == bundle["base_identity_revision"],
            "IDENTITY_CHANGE_OVERLAY_BASIS_MISMATCH", 409)
    next_bindings = dict(identity["bindings"])
    for occurrence, change in bundle["binding_updates"].items():
        require(next_bindings.get(occurrence) == change["previous"], "IDENTITY_CHANGE_BINDING_STALE", 409)
        next_bindings[occurrence] = deepcopy(change["next"])
    return dict(identity, identity_revision=bundle["target_identity_revision"], bindings=next_bindings)


def _endpoint_changes(statements, binding_updates):
    mapped = {}
    for key, statement in statements.items():
        changes = []
        for position in statement["endpoints"]:
            update = binding_updates.get(position["occurrence_ref"])
            if update and update["previous"]["entity_ref"] != update["next"]["entity_ref"]:
                changes.append(dict(**position, before_entity_ref=update["previous"]["entity_ref"],
                                    after_entity_ref=update["next"]["entity_ref"]))
        if changes:
            mapped[key] = changes
    return mapped


def plan_identity_change(snapshot, adopted, review, request, actor, *, impact_reader=None):
    """Pure plan used by the read-only PG adapter and deterministic fixtures."""
    library = snapshot["library_ref"]
    require(snapshot["identity_revision"] == adopted["identity_revision"]
            and request["base_view_revision"] == adopted["view_revision"], "IDENTITY_COMPOUND_BASIS_STALE")
    operation = request.get("client_operation_ref")
    require(isinstance(actor, str) and actor.strip() and isinstance(operation, str) and operation.strip(),
            "IDENTITY_OPERATION_ACTOR_REQUIRED", 422)
    intent = request["intent"]
    kind, reason = intent.get("kind"), intent.get("reason")
    require(request.get("contract") == "ontoweave-decision-request/1" and request.get("target_kind") == "IDENTITY"
            and kind in ACTIONS and set(intent) <= {"kind", "reason", "evidence_refs"}
            and isinstance(reason, str) and reason.strip(), "IDENTITY_DECISION_INTENT_INVALID", 422)
    groups = Groups(set(snapshot["homes"].values()), snapshot["history"])
    key = request["review_ref"]
    current = _reviews(snapshot, groups).get(key)
    require(current and review["review_ref"] == key and review.get("basis_sha256") == current["basis_sha256"],
            "IDENTITY_REVIEW_BASIS_CHANGED")
    allowed = {item["kind"] for item in current["available_actions"]}
    require(kind in allowed, "IDENTITY_DECISION_ACTION_UNAVAILABLE", 422)
    selected = intent.get("evidence_refs", current["source_refs"])
    require(isinstance(selected, list) and bool(selected) and all(isinstance(e, str) for e in selected)
            and set(selected) <= set(current["source_refs"])
            and all(set(selected).intersection(side["source_refs"]) for side in current["sides"]),
            "IDENTITY_DECISION_EVIDENCE_MISMATCH", 422)
    left, right, supersedes = _plan(ACTIONS[kind], dict(zip(("left_ref", "right_ref"), current["entity_refs"])), groups)
    publication_decision_ref = ref("decision", library, operation)
    event = _event(
        library, publication_decision_ref, ACTIONS[kind], left, right,
        operation=kind, actor=dict(kind="HUMAN", actor_ref=actor), reason=reason.strip(),
        supersedes=supersedes, publication_decision_ref=publication_decision_ref, review_ref=key,
        compound_basis_view=adopted["view_revision"], evidence_refs=sorted(set(selected)),
        evidence_sha256=current["basis_sha256"],
    )
    target = identity_ref("identity_rev", [library, snapshot["sequence"] + 1, [event["decision_ref"]]])
    next_groups = Groups(set(snapshot["homes"].values()), [*snapshot["history"], event])
    updates = _binding_updates(snapshot, next_groups)
    occurrences, statements = snapshot["occurrences"], snapshot["statements"]
    impact = _impact(adopted, left, right, groups, occurrences, statements, impact_reader)
    related = {s: statements[s] for s in impact["scope"]["statement_refs"]}
    moved = _endpoint_changes(related, updates)
    affected = sorted(related) if updates else []
    redirects = [{"from": entity, "to": next_groups.representative[entity]}
                 for entity in (left, right) if entity != next_groups.representative[entity]]
    before = dict(entities=current["sides"], review_status="OPEN")
    after = dict(entity_refs=sorted({next_groups.representative[e] for e in (left, right)}),
                 entity_redirects=redirects, review_status="DECIDED", relationship=ACTIONS[kind])
    body = dict(contract=CHANGE_CONTRACT, library_ref=library, base_view_revision=adopted["view_revision"],
                base_identity_revision=snapshot["identity_revision"], base_identity_sequence=snapshot["sequence"],
                target_identity_revision=target, review_ref=key, identity_event=event,
                binding_updates=updates, entity_redirects=redirects, endpoint_changes=moved,
                affected_entity_refs=[left, right], affected_statement_refs=affected,
                changed_endpoint_statement_refs=sorted(moved),
                affected_candidate_refs=sorted({related[s]["candidate_ref"] for s in affected}))
    impact.update(affected_entity_refs=[left, right], affected_statement_refs=affected,
                  changed_endpoint_statement_refs=sorted(moved), human_confirmation_required=True,
                  unknown=[k for k, check in impact["checks"].items() if check["status"] != "READY"])
    return dict(before=before, after=after, impact=impact, identity_change=body)


def _fact_revisions(q, library, view):
    rows = q("""WITH RECURSIVE adopted AS (
                    SELECT m.view_revision,m.parent_view_revision,m.body FROM publication_v1.manifests m
                    JOIN publication_v1.confirmations c USING(library_ref,view_revision)
                    WHERE m.library_ref=%s AND m.view_revision=%s
                    UNION ALL
                    SELECT m.view_revision,m.parent_view_revision,m.body FROM publication_v1.manifests m
                    JOIN publication_v1.confirmations c USING(library_ref,view_revision)
                    JOIN adopted child ON m.view_revision=child.parent_view_revision
                    WHERE m.library_ref=%s
                ) SELECT DISTINCT body->>'fact_revision' AS fact_revision FROM adopted""",
             [library, view, library]).fetchall()
    return [row["fact_revision"] for row in rows]


def prepare_compound_decision(store, library, adopted, review, request, *, actor, impact_reader=None):
    """Read the current confirmed manifest, check its published card, and seal the local plan."""
    view = request["base_view_revision"]
    with store.transaction(readonly=True) as (q, _):
        assert_base(head(q, library), view)
        confirmed = manifest(q, library, view)
        require(confirmed == adopted, "IDENTITY_COMPOUND_BASIS_STALE")
        ref_key = request["review_ref"]
        published = projection(q, library, view, ("REVIEW",)).get(("REVIEW", ref_key))
        require(published and published.get("target_kind") == "IDENTITY"
                and published.get("review_status") == "OPEN" and review.get("review_ref") == ref_key
                and review.get("basis_sha256") == published.get("basis_sha256"),
                "IDENTITY_REVIEW_NOT_IN_CONFIRMED_VIEW", 409)
        snapshot = _identity_snapshot(q, library, confirmed["identity_revision"])
        plan = plan_identity_change(snapshot, confirmed, published, request, actor, impact_reader=impact_reader)
        body = plan["identity_change"]
        refs = body["affected_statement_refs"]
        groups = sorted(_prior_groups(q, library, _fact_revisions(q, library, view), refs)) if refs else []
        body["prior_group_keys"] = groups
        plan["impact"]["prior_group_keys"] = groups
        plan["identity_change"] = _seal(body)
        return plan
