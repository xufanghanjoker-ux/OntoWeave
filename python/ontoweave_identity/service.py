"""Prepare from persisted evidence, publish independently, then settle identity judgments."""

from datetime import datetime
from time import perf_counter

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require
from ontoweave_cq_similarity.core import digest

from .adoption import adoption_record, authenticated_material, candidate_risk, confidence_reason, impact_check
from .decisions import _event
from .input import build_profiles, ref
from .matching import Groups, identifier_comparison, profile_views, recall
from .publication import _graph_at, _receipt, apply_identity_change, read_identity_view, stage_job
from .storage import (bindings_at, check_base, create_revision, decisions_at, insert_decision, library_lock,
                      revision_at, reviews_at, source_state, update_bindings, vector_neighbors)


def _document_versions(row):
    return {(source.get("doc_ref"), source.get("revision")) for source in row["source_refs"]
            if source.get("doc_ref") and source.get("revision")}


def _scope_material(scope, old_occurrences, old_statements, occurrences, statements):
    target = {tuple(pair) for pair in scope["documents"]}
    prior = {tuple(pair) for pair in scope["prior_documents"]}
    retained = {key: row for key, row in old_statements.items()
                if _document_versions(row) and _document_versions(row) <= target}
    # If a mixed-origin statement lost material, accept newly authenticated
    # observations on its surviving sources, rather than keeping the old assertion.
    changed = target - prior
    for key in old_statements.keys() - retained.keys():
        changed.update(_document_versions(old_statements[key]) & target)
    chosen = {key: row for key, row in statements.items()
              if not _document_versions(row) or (_document_versions(row) <= target
                                                  and _document_versions(row) & changed)}
    endpoints = {endpoint["occurrence_ref"] for row in chosen.values() for endpoint in row["endpoints"]}
    chosen_occurrences = {key: row for key, row in occurrences.items() if key in endpoints or
                          (not row["statement_refs"] and _document_versions(row) & changed
                           and _document_versions(row) <= target)}
    old_endpoints = {endpoint["occurrence_ref"] for row in retained.values() for endpoint in row["endpoints"]}
    retained_occurrences = {key: row for key, row in old_occurrences.items() if key in old_endpoints or
                            (not row["statement_refs"] and _document_versions(row)
                             and _document_versions(row) <= target)}
    return retained_occurrences, retained, chosen_occurrences, chosen


def _store_preparation(store, request, occurrences, statements, sources, gaps):
    library = request["library_ref"]
    with store.transaction() as (q, _):
        head = library_lock(q, library, publisher=request.get("publication_mode") == "PG")
        active = check_base(q, head, request)
        require(head["pending_revision"] is None, "IDENTITY_APPLICATION_PENDING")
        version = head["active_revision"]
        old_homes, old_occurrences, old_statements = source_state(q, library, version)
        scope = request.get("product_source_scope")
        if scope:
            old_occurrences, old_statements, occurrences, statements = _scope_material(
                scope, old_occurrences, old_statements, occurrences, statements)
            old_homes = {key: old_homes[key] for key in old_occurrences}
        derived = {"home_entity_ref", "local_binding", "warnings", "competing_declarations"}
        for key in old_occurrences.keys() & occurrences.keys():
            require({k: v for k, v in old_occurrences[key].items() if k not in derived}
                    == {k: v for k, v in occurrences[key].items() if k not in derived},
                    "IDENTITY_OCCURRENCE_REPLAY_CHANGED")
        homes, _ = build_profiles(library, occurrences, old_occurrences, statements=statements)
        for key in old_statements.keys() & statements.keys():
            require(old_statements[key] == statements[key], "IDENTITY_STATEMENT_REPLAY_CHANGED")
        new = sorted(occurrences.keys() - old_homes.keys())
        new_statements = sorted(statements.keys() - old_statements.keys())
        groups = Groups(set(old_homes.values()) | set(homes.values()), decisions_at(q, library, version))
        current = {k: groups.representative[e] for k, e in {**old_homes, **homes}.items()}
        profiles = profile_views(current, {**old_occurrences, **occurrences}, {**old_statements, **statements})
        new_refs = {current[k] for k in new}
        vector_hits, vector_receipt = vector_neighbors(q, library, request.get("name_vector"), profiles, new_refs)
        pairs, truncation = recall(profiles, new_refs, vector_hits)
        known_reviews = {r["review_ref"] for r in reviews_at(q, library, version)}
        pairs = [p for p in pairs if p["review_ref"] not in known_reviews]
        for pair in pairs:
            restrictions = groups.constraints(pair["left_ref"], pair["right_ref"])
            pair["prior_different"] = [d["decision_ref"] for d in restrictions]
            pair["status"] = "PENDING"
            if restrictions:
                pair["status"] = "RECONSIDERATION" if pair["reliable_same"] or pair["direct_alias"] else "CLOSED"
            elif not pair["left"]["sources"] or not pair["right"]["sources"]:
                pair["status"] = "MATERIAL_INSUFFICIENT"
        payload = dict(
            contract="ontoweave-identity-preparation/1", request=request, library_ref=library,
            base_identity_revision=(active or {}).get("identity_revision"),
            base_view_revision=(active or {}).get("view_revision"),
            sources=sources, gaps=gaps, occurrences={k: occurrences[k] for k in new},
            statements={k: statements[k] for k in new_statements},
            profiles={e: profiles[e] for e in sorted(new_refs)}, pairs=pairs,
            counts=dict(occurrences=len(occurrences), statements=len(statements),
                        candidates=len({s["candidate_ref"] for s in statements.values()}),
                        new_occurrences=len(new), new_statements=len(new_statements), pairs=len(pairs),
                        lexical_truncation=truncation, vector_truncation=vector_receipt["truncation"]),
            name_vector=vector_receipt,
        )
        if scope:
            payload["active_scope"] = dict(source_snapshot_ref=scope["source_snapshot_ref"],
                                           occurrence_refs=sorted(old_occurrences.keys() | occurrences.keys()),
                                           statement_refs=sorted(old_statements.keys() | statements.keys()))
        prepared_ref = ref("identity_prepared", payload)
        payload["prepared_ref"] = prepared_ref
        q("INSERT INTO identity_v1.prepared(library_ref,prepared_ref,payload) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
          [library, prepared_ref, Jsonb(payload)])
        return payload


def read_preparation(store, prepared_ref):
    with store.transaction(readonly=True) as (q, _):
        row = q("SELECT payload FROM identity_v1.prepared WHERE prepared_ref=%s", [prepared_ref]).fetchone()
        require(row, "IDENTITY_PREPARATION_UNKNOWN")
        value = row["payload"]
        require(prepared_ref == ref("identity_prepared", {k: v for k, v in value.items() if k != "prepared_ref"}),
                "IDENTITY_PREPARATION_CHANGED")
        return value


def _job_for(q, library, marker, prepared_ref):
    # Both call sites pass internal, fixed marker names.
    return q("""SELECT status,payload FROM identity_v1.publication_jobs
                WHERE library_ref=%s AND payload->>%s=%s""", [library, marker, prepared_ref]).fetchone()


def _put_sources(q, revision, occurrences, statements):
    library, version = revision["library_ref"], revision["revision"]
    for entity in sorted({o["home_entity_ref"] for o in occurrences.values()}):
        q("INSERT INTO identity_v1.entities VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
          [library, entity, version])
    for key, statement in statements.items():
        q("INSERT INTO identity_v1.statements VALUES(%s,%s,%s,%s,%s)",
          [library, key, version, statement["candidate_ref"], Jsonb(statement)])
    for key, occurrence in occurrences.items():
        statement = next(iter(occurrence["statement_refs"]), None)
        q("INSERT INTO identity_v1.occurrences VALUES(%s,%s,%s,%s,%s,%s,%s)",
          [library, key, occurrence["home_entity_ref"], statement, occurrence["origin"]["item_ref"],
           occurrence["role"], Jsonb(occurrence)])


def _marked_job(q, receipt, marker, prepared_ref, overrides=None, *, initial_judgments_sha=None):
    extra = {marker: prepared_ref}
    if overrides is not None:
        extra["review_overrides"] = overrides
    if initial_judgments_sha is not None:
        extra["initial_judgments_sha256"] = initial_judgments_sha
    q("UPDATE identity_v1.publication_jobs SET payload=payload||%s WHERE job_ref=%s",
      [Jsonb(extra), receipt["job_ref"]])


def _group_conflicts(groups, left, right, individual):
    a, b = groups.representative[left], groups.representative[right]
    if a == b:
        return []
    conflicts = []
    for x in sorted(groups.members[a] & individual.keys()):
        for y in sorted(groups.members[b] & individual.keys()):
            conflicts.extend(identifier_comparison(individual[x], individual[y])[1])
    return conflicts


def _initial_events(library, pairs, homes, individual, history, prepared_ref, prior_entities):
    groups = Groups(set(homes.values()), history)
    events = []
    for pair in pairs:
        left, right = pair["left_ref"], pair["right_ref"]
        if pair["reliable_different"] and not groups.constraints(left, right):
            event = _event(library, prepared_ref + ":" + pair["review_ref"] + ":different", "DIFFERENT",
                           left, right, actor=dict(kind="SYSTEM", actor_ref="identity_v1"),
                           evidence=pair["reliable_different"], method="RELIABLE_DISJOINT_IDENTIFIER")
            events.append(event)
    groups = Groups(set(homes.values()), [*history, *events])
    # A direct alias can identify one intended counterpart. Keep competing same-name matches pending.
    matches = {}
    for pair in pairs:
        if pair["direct_alias"] and not pair["reliable_different"]:
            for a, b in [(pair["left_ref"], pair["right_ref"]), (pair["right_ref"], pair["left_ref"])]:
                matches.setdefault(a, set()).add(b)
    for pair in pairs:
        left, right = pair["left_ref"], pair["right_ref"]
        if groups.representative[left] == groups.representative[right] or groups.constraints(left, right):
            continue
        direct = pair["direct_alias"] and len(matches[left]) == len(matches[right]) == 1
        if not pair["reliable_same"] and not direct:
            continue
        if _group_conflicts(groups, left, right, individual):
            continue
        method = "RELIABLE_UNIQUE_IDENTIFIER" if pair["reliable_same"] else "EXPLICIT_SOURCE_ALIAS"
        current_left, current_right = sorted(groups.representative[e] for e in (left, right))
        survivor = current_left if current_left in prior_entities or current_right not in prior_entities else current_right
        event = _event(library, prepared_ref + ":" + pair["review_ref"] + ":same", "SAME", left, right,
                       actor=dict(kind="SYSTEM", actor_ref="identity_v1"), method=method, survivor_ref=survivor,
                       evidence=pair["reliable_same"] or pair["direct_alias"], review_ref=pair["review_ref"])
        groups.join(left, right, event["decision_ref"], survivor)
        events.append(event)
    return events, groups


def stage_preparation(store, prepared_ref, *, publisher=False, initial_judgments=None, dispatch_guard=None):
    prepared = read_preparation(store, prepared_ref)
    library = prepared["library_ref"]
    judgments_sha = digest(initial_judgments) if initial_judgments is not None else None
    require(judgments_sha is None or publisher and dispatch_guard, "IDENTITY_PRODUCT_INITIAL_BASE_REQUIRED")
    with store.transaction() as (q, _):
        head = library_lock(q, library, publisher=publisher)
        existing = _job_for(q, library, "initial_prepared_ref", prepared_ref)
        if existing:
            require(judgments_sha is None or existing["payload"].get("initial_judgments_sha256") == judgments_sha,
                    "IDENTITY_PRODUCT_JUDGMENTS_CHANGED")
            job_ref = existing["payload"]["job_ref"]
        else:
            active = check_base(q, head, prepared)
            occurrences, statements = prepared["occurrences"], prepared["statements"]
            if not occurrences and not statements:
                require(active or prepared["sources"], "IDENTITY_NO_ELIGIBLE_MATERIAL")
                if active and not prepared.get("active_scope"):
                    return dict(application_status="UNCHANGED", active=True, **{
                        k: active[k] for k in ("identity_revision", "view_revision")})
            if prepared.get("active_scope"):
                from ontoweave_publication.store import assert_base, head as publisher_head

                require(publisher and dispatch_guard, "IDENTITY_PRODUCT_SUCCESSOR_SCOPE_REQUIRED")
                assert_base(publisher_head(q, library, lock=True), prepared["request"]["publication_base_view_revision"])
                dispatch_guard(q)
            if initial_judgments is not None:
                from ontoweave_publication.store import head as publisher_head

                publication = publisher_head(q, library, lock=True)
                dispatch_guard(q)
                require(publisher and active is None and publication["active_view_revision"] is None
                        and publication["pending_view_revision"] is None, "IDENTITY_PRODUCT_INITIAL_BASE_CHANGED")
            seed = prepared_ref if judgments_sha is None else [prepared_ref, judgments_sha]
            revision = create_revision(q, head, seed)
            _put_sources(q, revision, occurrences, statements)
            scope = prepared.get("active_scope")
            if scope:
                q("INSERT INTO identity_v1.product_source_scopes VALUES(%s,%s,%s,%s,%s)",
                  [library, revision["revision"], scope["source_snapshot_ref"],
                   scope["occurrence_refs"], scope["statement_refs"]])
            homes, occurrences, full_statements = source_state(q, library, revision["revision"])
            individual = profile_views(homes, occurrences, full_statements)
            previous = bindings_at(q, library, head["active_revision"])
            history = decisions_at(q, library, head["active_revision"])
            events, groups = _initial_events(library, prepared["pairs"], homes, individual, history, prepared_ref,
                                             {b["entity_ref"] for b in previous.values()})
            overrides = None
            if initial_judgments is not None:
                from .publication import Ports

                # The publisher and identity heads were locked and have never been activated.
                # All affected statements will go through the first fact, graph and index publication.
                impact = Ports(impact=lambda _scope: {
                    key: dict(status="READY", refs=[], scope="EMPTY_INITIAL_PUBLICATION")
                    for key in ("declared_constraint_collisions", "adopted_derivations", "citation_dependencies")
                })
                judged, overrides = _judgment_events(q, library, revision["revision"], None, prepared,
                                                     initial_judgments, groups, individual, impact, prepared_ref)
                events.extend(judged)
            for ordinal, event in enumerate(events):
                insert_decision(q, library, revision["revision"], event, ordinal)
            for review in prepared["pairs"]:
                q("""INSERT INTO identity_v1.reviews
                     (library_ref,review_ref,left_ref,right_ref,evidence_sha256,strategy,first_revision,payload)
                     VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
                  [library, review["review_ref"], review["left_ref"], review["right_ref"],
                   review["evidence_sha256"], review["strategy"], revision["revision"], Jsonb(review)])
            updates = update_bindings(q, library, revision["revision"], homes, groups, previous)
            for statement in statements:
                full_statements[statement]["is_new"] = True
            receipt = stage_job(q, revision, [e["decision_ref"] for e in events],
                                {key: binding for key, binding in previous.items() if key in occurrences},
                                updates, occurrences, full_statements)
            job_ref = receipt["job_ref"]
            _marked_job(q, receipt, "initial_prepared_ref", prepared_ref, overrides, initial_judgments_sha=judgments_sha)
    return job_ref


def prepare_first_publication(store, prepared, runtime, *, dispatch_guard):
    """Run eligible identity judgments before staging the single publisher-owned initial revision."""
    from .agent import judge
    from .publication import _live_reviews

    require(prepared["request"].get("publication_mode") == "PG" and prepared["base_identity_revision"] is None,
            "IDENTITY_PRODUCT_INITIAL_BASE_REQUIRED")
    library = prepared["library_ref"]
    homes = {key: row["home_entity_ref"] for key, row in prepared["occurrences"].items()}
    individual = profile_views(homes, prepared["occurrences"], prepared["statements"])
    _, groups = _initial_events(library, prepared["pairs"], homes, individual, [], prepared["prepared_ref"], set())
    candidates = [dict(pair, stored_revision=1) for pair in prepared["pairs"]
                  if not groups.constraints(pair["left_ref"], pair["right_ref"])]
    live = _live_reviews(candidates, groups)
    pairs = [pair for pair in prepared["pairs"] if live.get(pair["review_ref"], {}).get("status") == "PENDING"]
    with store.transaction(readonly=True) as (q, _):
        prior = _prior_batches(q, library, prepared["prepared_ref"])
    prior_refs = {label["review_ref"] for row in prior for label in row["labels"].values()}
    remaining = ([] if any(r["status"] in ("FAILED", "UNKNOWN_HOLD") for r in prior)
                 else [p for p in pairs if p["review_ref"] not in prior_refs])
    judgments, batches, status = judge(store, prepared, remaining, runtime, publisher=True, prior_batches=prior)
    if status == "FAILED":
        status = "PARTIAL"
    result = dict(execution_status=status, judgments=judgments, batches=batches, eligible_pairs=len(pairs),
                  judgment_cache_hits=sum("cached_from" in a for a in judgments.values()),
                  prepared_ref=prepared["prepared_ref"], job_ref=None, identity_revision=None)
    if status != "UNKNOWN_HOLD":
        job = stage_preparation(store, prepared["prepared_ref"], publisher=True, initial_judgments=judgments,
                                dispatch_guard=dispatch_guard)
        with store.transaction(readonly=True) as (q, _):
            row = q("SELECT payload FROM identity_v1.publication_jobs WHERE library_ref=%s AND job_ref=%s",
                    [library, job]).fetchone()
        result.update(job_ref=job, identity_revision=row["payload"]["target_identity_revision"])
    return result


def prepare_product_successor(store, prepared, dispatch_guard):
    require(prepared.get("active_scope") and prepared.get("base_identity_revision"), "IDENTITY_PRODUCT_SUCCESSOR_SCOPE_REQUIRED")
    job = stage_preparation(store, prepared["prepared_ref"], publisher=True, dispatch_guard=dispatch_guard)
    with store.transaction(readonly=True) as (q, _):
        row = q("SELECT payload FROM identity_v1.publication_jobs WHERE job_ref=%s", [job]).fetchone()
    return dict(execution_status="COMPLETED", judgments={}, batches=[], eligible_pairs=len(prepared["pairs"]),
                prepared_ref=prepared["prepared_ref"], job_ref=job,
                identity_revision=row["payload"]["target_identity_revision"])


def publish_preparation(store, prepared_ref, ports=None):
    staged = stage_preparation(store, prepared_ref)
    return staged if isinstance(staged, dict) else apply_identity_change(store, staged, ports)


def _judgment_events(q, library, version, view_revision, prepared, judgments, groups, individual, ports,
                     publication_ref):
    qualified = {}
    for review in prepared["pairs"]:
        key = review["review_ref"]
        answer = judgments.get(key)
        if answer and answer.get("judgment") in ("SAME", "DIFFERENT") and confidence_reason(answer) is None:
            qualified[key] = authenticated_material(review, answer)
    negative = [(r["left_ref"], r["right_ref"]) for r in prepared["pairs"]
                if judgments.get(r["review_ref"], {}).get("judgment") == "DIFFERENT"
                and qualified.get(r["review_ref"])]
    overrides, events = {}, []
    for review in prepared["pairs"]:
        key = review["review_ref"]
        answer = judgments.get(key)
        if answer is None:
            continue
        label = answer.get("judgment")
        override = dict(status="PENDING", judgment=answer)
        overrides[key] = override

        def finish(status, reason, *, review_status=None, impact=None):
            override.update(adoption=reason, adoption_details=adoption_record(status, reason, impact))
            if review_status:
                override["status"] = review_status

        if label is None:
            finish("TECHNICAL_PENDING", "TECHNICAL_JUDGMENT_PENDING", review_status="TECHNICAL_PENDING")
            continue
        if label == "UNKNOWN":
            finish("NOT_APPLIED", "MODEL_UNCERTAIN", review_status="MATERIAL_INSUFFICIENT")
            continue
        score_reason = confidence_reason(answer)
        if score_reason:
            finish("NOT_APPLIED", score_reason)
            continue
        if not qualified.get(key):
            finish("TECHNICAL_PENDING", "BILATERAL_EVIDENCE_UNAUTHENTICATED", review_status="TECHNICAL_PENDING")
            continue
        if label == "DIFFERENT":
            override["scoped_distinction"] = dict(evidence_sha256=review["evidence_sha256"],
                                                   entity_refs=[review["left_ref"], review["right_ref"]])
            finish("APPLIED", "SCOPED_DIFFERENT_RETAINED", review_status="CLOSED")
            continue
        left, right = review["left_ref"], review["right_ref"]
        left_group, right_group = groups.representative[left], groups.representative[right]
        if left_group == right_group:
            finish("NOT_APPLIED", "ALREADY_MAPPED", review_status="CLOSED")
            continue
        blocked = (groups.constraints(left, right) or _group_conflicts(groups, left, right, individual)
                   or any({groups.representative[a], groups.representative[b]} == {left_group, right_group}
                          for a, b in negative))
        if blocked or review["reliable_different"]:
            finish("NOT_APPLIED", "KNOWN_CONFLICT")
            continue
        if reason := candidate_risk(review):
            finish("NOT_APPLIED", reason)
            continue
        members = groups.members[left_group] | groups.members[right_group]
        refs = sorted({s for e in members for s in individual[e]["statement_refs"]})
        scope = dict(library_ref=library, view_revision=view_revision,
                     entity_refs=sorted((left_group, right_group)), home_entity_refs=sorted(members),
                     statement_refs=refs)
        impact = impact_check(q, library, version, scope, ports)
        receipt = dict(**impact, scope=scope)
        override["adoption_impact"] = receipt
        if not impact["ready"]:
            if impact["reason"] in {"IMPACT_INCOMPLETE", "IMPACT_READ_FAILED"}:
                finish("TECHNICAL_PENDING", impact["reason"], review_status="TECHNICAL_PENDING", impact=receipt)
            else:
                finish("NOT_APPLIED", impact["reason"], impact=receipt)
            continue
        event = _event(library, publication_ref + ":" + key + ":model-same", "SAME",
                       left, right, actor=dict(kind="AGENT", actor_ref="native_codex"),
                       method="MODEL_CONFIDENCE_EXECUTION_GATE", review_ref=key,
                       evidence=dict(answer=answer, authenticated_material=qualified[key], impact=receipt))
        groups.join(left, right, event["decision_ref"])
        events.append(event)
        finish("APPLIED", "AUTO_APPLIED", review_status="CLOSED", impact=receipt)
        override["decision_ref"] = event["decision_ref"]
    return events, overrides


def _judgment_publication(store, prepared, first, judgments, ports, *, publication_ref=None):
    library = prepared["library_ref"]
    prepared_ref = prepared["prepared_ref"]
    publication_ref = publication_ref or prepared_ref
    with store.transaction() as (q, _):
        head = library_lock(q, library)
        active = revision_at(q, library, head["active_revision"])
        existing = _job_for(q, library, "judgment_prepared_ref", publication_ref)
        if existing:
            job_ref = existing["payload"]["job_ref"]
        elif active["view_revision"] != first["view_revision"] or head["pending_revision"]:
            return dict(application_status="LATE_ARCHIVED", active_view_revision=active["view_revision"])
        else:
            version = head["active_revision"]
            homes, occurrences, statements = source_state(q, library, version)
            previous = bindings_at(q, library, version)
            history = decisions_at(q, library, version)
            groups = Groups(set(homes.values()), history)
            individual = profile_views(homes, occurrences, statements)
            events, overrides = _judgment_events(q, library, version, active["view_revision"], prepared,
                                                  judgments, groups, individual, ports, publication_ref)
            if not overrides:
                return first
            rev = create_revision(q, head, [publication_ref, digest(overrides)])
            for ordinal, event in enumerate(events):
                insert_decision(q, library, rev["revision"], event, ordinal)
            updates = update_bindings(q, library, rev["revision"], homes, groups, previous)
            receipt = stage_job(q, rev, [event["decision_ref"] for event in events], previous, updates,
                                occurrences, statements)
            job_ref = receipt["job_ref"]
            _marked_job(q, receipt, "judgment_prepared_ref", publication_ref, overrides)
    return apply_identity_change(store, job_ref, ports)


def _prior_batches(q, library, prepared_ref):
    rows = q("""SELECT status,payload FROM identity_v1.batch_results
                WHERE library_ref=%s AND prepared_ref=%s ORDER BY batch_ref""",
             [library, prepared_ref]).fetchall()
    return [{**row["payload"], "status": "UNKNOWN_HOLD" if row["status"] == "STARTED" else row["status"],
             "reused": True} for row in rows]


def continue_identity(store, prepared_ref, continuation_id, runtime, review_refs=(), ports=None):
    from .agent import judge
    from .storage import migrate

    require(runtime is not None and bool(continuation_id.strip()), "IDENTITY_CONTINUATION_RUNTIME_REQUIRED")
    migrate(store)
    prepared = read_preparation(store, prepared_ref)
    library = prepared["library_ref"]
    selected = sorted(set(review_refs))
    key = [library, prepared_ref, continuation_id]
    attempt_ref = ref("identity_continuation", key)
    with store.transaction() as (q, _):
        head = library_lock(q, library)
        active = revision_at(q, library, head["active_revision"])
        previous = q("""SELECT selection,result FROM identity_v1.continuations
                        WHERE library_ref=%s AND prepared_ref=%s AND continuation_id=%s""", key).fetchone()
        if previous:
            require(previous["selection"]["requested"] == selected, "IDENTITY_CONTINUATION_SELECTION_CONFLICT")
            require(previous["result"] is not None, "IDENTITY_CONTINUATION_ALREADY_STARTED")
            return {**previous["result"], "reused": True, "generation_requests": 0, "simulated_requests": 0}
        require(active and not head["pending_revision"]
                and _job_for(q, library, "initial_prepared_ref", prepared_ref), "IDENTITY_CONTINUATION_BASE_UNAVAILABLE")
        require(not q("""SELECT 1 FROM identity_v1.continuations
                         WHERE library_ref=%s AND prepared_ref=%s AND status='STARTED'""", key[:2]).fetchone(),
                "IDENTITY_CONTINUATION_ALREADY_STARTED")
        existing = _prior_batches(q, library, prepared_ref)
        reviews = _graph_at(q, library, head["active_revision"], "REVIEW")
        states, reused = {}, {}
        for pair in prepared["pairs"]:
            review_ref = pair["review_ref"]
            review = reviews.get(review_ref)
            if not review or review["status"] not in ("PENDING", "TECHNICAL_PENDING"):
                continue
            states[review_ref] = "NOT_DISPATCHED"
        for row in existing:
            for label in row["labels"].values():
                review_ref = label["review_ref"]
                answer = row.get("judgments", {}).get(review_ref, {})
                if "judgment" in answer:
                    reused[review_ref] = answer
                    states[review_ref] = "COMPLETED"
                elif review_ref in states and states[review_ref] not in ("COMPLETED", "UNKNOWN_HOLD"):
                    if row["status"] == "UNKNOWN_HOLD":
                        states[review_ref] = "UNKNOWN_HOLD"
                    elif row["status"] != "HELD_AFTER_TECHNICAL_FAILURE":
                        states[review_ref] = "KNOWN_GAP"
        eligible = {k for k, state in states.items() if state in ("KNOWN_GAP", "NOT_DISPATCHED")}
        require(set(selected) <= eligible, "IDENTITY_CONTINUATION_SELECTION_INELIGIBLE")
        pending = set(selected) if selected else eligible
        pairs = [pair for pair in prepared["pairs"] if pair["review_ref"] in pending]
        baseline = dict(view_revision=active["view_revision"])
        selection = dict(requested=selected, dispatched=sorted(pending), states=states, base_view_revision=active["view_revision"])
        q("""INSERT INTO identity_v1.continuations(library_ref,prepared_ref,continuation_id,selection,status)
             VALUES(%s,%s,%s,%s,'STARTED')""", [*key, Jsonb(selection)])
    judgments, batches, status = judge(store, prepared, pairs, runtime, continuation=attempt_ref)
    publication = (_judgment_publication(store, prepared, baseline, judgments, ports, publication_ref=attempt_ref)
                   if judgments and not any(a.get("concurrent_judgment") for a in judgments.values()) else dict(application_status="UNCHANGED", view_revision=baseline["view_revision"]))
    unknown = ({k for k, state in states.items() if state == "UNKNOWN_HOLD"}
               | {k for k, a in judgments.items() if a.get("code") == "UNKNOWN_HOLD"})
    remaining = ((eligible - pending) | {k for k, a in judgments.items() if "judgment" not in a}) - unknown
    if unknown:
        status = "UNKNOWN_HOLD"
    elif remaining and status not in ("FAILED", "UNKNOWN_HOLD"):
        status = "PARTIAL"
    result = dict(prepared_ref=prepared_ref, continuation_id=continuation_id, continuation_ref=attempt_ref,
                  selection=selection, reused_judgments=reused, judgments=judgments, batches=batches,
                  publication=publication, execution_status=status, unknown_review_refs=sorted(unknown),
                  remaining_review_refs=sorted(remaining),
                  generation_requests=sum(b.get("native", {}).get("generation_requests", 0) for b in batches),
                  simulated_requests=sum(b.get("native", {}).get("simulated_requests", 0) for b in batches),
                  embedding_requests=0)
    with store.transaction() as (q, _):
        q("""UPDATE identity_v1.continuations SET status='SETTLED',result=%s
             WHERE library_ref=%s AND prepared_ref=%s AND continuation_id=%s""", [Jsonb(result), *key])
    return result


def resolve_identity(store, prepared_ref, runtime=None, ports=None):
    from .agent import judge
    from .storage import migrate

    started = perf_counter()
    prepared = read_preparation(store, prepared_ref)
    first = publish_preparation(store, prepared_ref, ports)
    first_ms = (perf_counter() - started) * 1000
    if first["application_status"] == "FAILED":
        return dict(contract="ontoweave-identity-result/1", prepared_ref=prepared_ref, first_publication=first,
                    publication=first, execution_status="FAILED", generation_requests=0,
                    simulated_requests=0, embedding_requests=0)
    library = prepared["library_ref"]
    first_view = read_identity_view(store, library, first["view_revision"])
    live = {r["review_ref"] for r in first_view["reviews"] if r["status"] == "PENDING"}
    pairs = [r for r in prepared["pairs"] if r["review_ref"] in live]
    publish_judgments = True
    if runtime is None:
        judgments, batches, technical = {}, [], "NOT_REQUESTED"
    else:
        migrate(store)
        with store.transaction(readonly=True) as (q, _):
            prior = [r for r in _prior_batches(q, library, prepared_ref) if not r.get("continuation_ref")]
        prior_refs = {label["review_ref"] for row in prior for label in row["labels"].values()}
        # Once a technical batch halted dispatch, a normal re-entry is read-only.
        new_pairs = ([] if any(r["status"] in ("FAILED", "UNKNOWN_HOLD") for r in prior)
                     else [r for r in pairs if r["review_ref"] not in prior_refs])
        judgments, batches, technical = judge(store, prepared, new_pairs, runtime, prior_batches=prior)
        # A concurrent observer must not publish a placeholder over the eventual result.
        with store.transaction(readonly=True) as (q, _):
            inflight = q("""SELECT 1 FROM identity_v1.batch_results
                            WHERE library_ref=%s AND prepared_ref=%s AND status='STARTED'""",
                         [library, prepared_ref]).fetchone()
        publish_judgments = (not inflight and not any(b.get("concurrent_continuation") for b in batches)
                             and not any(a.get("concurrent_judgment") for a in judgments.values()))
    last = _judgment_publication(store, prepared, first, judgments, ports) if judgments and publish_judgments else first
    view = read_identity_view(store, library)
    def changed(key):
        return sorted(set(first.get("delta", {}).get(key, [])) | set(last.get("delta", {}).get(key, [])))
    return dict(
        contract="ontoweave-identity-result/1", library_ref=library, prepared_ref=prepared_ref,
        identity_revision=view["identity_revision"], view_revision=view["view_revision"],
        first_publication=first, publication=last, bindings=view["bindings"],
        review_refs=[r["review_ref"] for r in view["reviews"]],
        changed_entity_refs=changed("affected_entity_refs"),
        changed_statement_refs=changed("affected_statement_refs"),
        changed_candidate_refs=changed("affected_candidate_refs"),
        warnings=prepared["gaps"], judgments=judgments, batches=batches, execution_status=technical,
        judgment_cache_hits=sum("cached_from" in a for a in judgments.values()),
        generation_requests=sum(b.get("native", {}).get("generation_requests", 0) for b in batches if not b.get("reused")),
        simulated_requests=sum(b.get("native", {}).get("simulated_requests", 0) for b in batches if not b.get("reused")),
        embedding_requests=0,
        timing_ms=dict(first_graph=first_ms, total=(perf_counter() - started) * 1000),
    )
