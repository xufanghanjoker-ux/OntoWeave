from psycopg.types.json import Jsonb

from .coordinator import enqueue
from .readers import Reader
from .store import assert_base, assert_workspace_writable, digest, event, get_job, head, manifest, projection, ref, require, review_rows


def _request_sha(request):
    return digest({key: value for key, value in request.items() if key != "preview_ref"})


class Decisions:
    def __init__(self, store, plan_intent=None, *, review_reader=None):
        self.store = store
        self.plan_intent = plan_intent
        self.review_reader = review_reader if review_reader is not None else Reader(
            store, review_domains=getattr(plan_intent, "enabled", None), runs_human_jobs=True)

    def fact_correction_basis(self, library, fact, view):
        with self.store.transaction(readonly=True) as (q, _):
            state = head(q, library)
            assert_base(state, view)
            return self._fact_correction_basis(q, library, fact, view, state)

    def _fact_correction_basis(self, q, library, fact, view, state):
        require((self.review_reader.review_domains is None or "FACT" in self.review_reader.review_domains)
                and self.review_reader.runs_human_jobs,
                "HUMAN_JOB_WORKER_UNAVAILABLE", 503)
        require(not self.review_reader._publication_pending(q, state, view), "REVIEW_PUBLICATION_PENDING")
        rows = projection(q, library, view, ("FACT", "SOURCE"))
        known = rows.get(("FACT", fact))
        require(known, "OBJECT_NOT_IN_VIEW", 404)
        evidence = []
        for source_ref in known["source_refs"]:
            source = rows.get(("SOURCE", source_ref))
            if source and source.get("text") and source.get("doc_ref") and source.get("revision"):
                evidence.append(dict(source_ref=source_ref, text=source["text"], preview=source["text"],
                                     precision=source.get("precision"), location=source))
        require(evidence, "FACT_CORRECTION_EVIDENCE_UNAVAILABLE", 422)
        content = known["content"]
        target = ref("fact_correction", library, fact, view)
        version = known["fact_version_ref"]
        side = dict(fact_ref=fact, fact_version_ref=version, definition_ref=known["definition_ref"],
                    value=content["value"], evidence=evidence, world_time=known["world_time"],
                    source_refs=[row["source_ref"] for row in evidence], time_alternatives=[])
        editable = ["negated"]
        if content["value"]["kind"] == "VALUE":
            editable.append("value")
        return dict(review_ref=target, review_kind="FACT", target_kind="FACT", review_status="OPEN",
                    proactive_fact_ref=fact, title="更正一条知识", view_revision=view, target_fact_version_ref=version,
                    basis_version=ref("fact_correction_basis", target, version, evidence),
                    basis=dict(fact_version_refs=[version]), impact=dict(group_keys=[known["group_key"]]),
                    available_actions=[dict(kind="CORRECT_FACT", editable_fields=editable)],
                    source_refs=side["source_refs"], sides=[side], evidence=evidence)

    def _target(self, q, library, view, target, request, revert, *, state):
        if getattr(self.store, "workspace_write_guard", None):
            busy = q("""SELECT 1 FROM product_upload_v1.uploads u JOIN publication_v1.builds b
                        USING(library_ref,run_ref) WHERE u.library_ref=%s
                        AND b.body->>'execution_status' IN ('QUEUED','RUNNING','UNKNOWN_HOLD') LIMIT 1""", [library]).fetchone()
            require(not busy, "DOCUMENT_BUILD_UNSETTLED")
        pending = self.review_reader._publication_pending(q, state, view)
        if revert:
            require(self.review_reader.runs_human_jobs, "HUMAN_JOB_WORKER_UNAVAILABLE", 503)
            require(not pending, "REVIEW_PUBLICATION_PENDING")
            original = q("""SELECT * FROM publication_v1.decisions
                            WHERE library_ref=%s AND decision_ref=%s""", [library, target]).fetchone()
            require(original, "DECISION_NOT_FOUND", 404)
            require(original["status"] == "APPLIED", "DECISION_REVERT_NOT_APPLICABLE", 422)
            return original
        require(request["review_ref"] == target, "DECISION_TARGET_MISMATCH", 422)
        if "proactive_fact_ref" in request:
            row = self._fact_correction_basis(q, library, request["proactive_fact_ref"], view, state)
            edit = request["intent"].get("proposed_content")
            require(row["review_ref"] == target and request["intent"].get("kind") == "CORRECT_FACT"
                    and isinstance(edit, dict) and set(edit) <= set(row["available_actions"][0]["editable_fields"]),
                    "FACT_INTENT_INVALID", 422)
            return row
        row = review_rows(q, library, view).get(("REVIEW", target))
        require(row, "OBJECT_NOT_IN_VIEW", 404)
        detail = self.review_reader._visible_review(q, library, view, target, row,
                                                    state=state, publication_pending=pending)
        action = request["intent"].get("kind")
        expected = "REVIEW" if action == "DEFER" else detail.get("target_kind")
        require(request["target_kind"] == expected, "DECISION_TARGET_MISMATCH", 422)
        require(detail["review_status"] in {"OPEN", "DEFERRED"}, "DECISION_TARGET_CHANGED")
        eligibility = detail["review_eligibility"]
        status = eligibility["status"]
        if status != "ACTIONABLE":
            http_status = (503 if status in {"WORKER_DISABLED", "TECHNICAL_PENDING"}
                           else 409 if status == "PUBLICATION_PENDING" else 422)
            require(False, eligibility["reason_code"] or "DECISION_ACTION_INVALID", http_status,
                    review_eligibility=eligibility)
        require(action in {item["kind"] for item in detail["available_actions"]}, "DECISION_ACTION_INVALID", 422)
        return detail

    def preview(self, library, actor, target, request, *, revert=False):
        require(self.plan_intent, "DECISION_ADAPTER_UNAVAILABLE", 503)
        require(revert or request["intent"].get("kind") != "DEFER", "PREVIEW_NOT_REQUIRED", 422)
        base = request["base_view_revision"]
        with self.store.transaction(readonly=True) as (q, _):
            state = head(q, library)
            assert_base(state, base)
            adopted = manifest(q, library, base)
            current = self._target(q, library, base, target, request, revert, state=state)
        plan = self.plan_intent(library, adopted, current, request, actor=actor, revert=revert)
        require(all(key in plan for key in ("publication", "bundle", "graph_delta", "index_delta", "before",
                                            "after", "impact")), "DECISION_PLAN_INVALID", 503)
        checksum = _request_sha(request)
        preview = ref("preview", library, target, actor, checksum, digest(plan))
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            assert_workspace_writable(self.store, q, library)
            assert_base(state, base)
            self._target(q, library, base, target, request, revert, state=state)
            q("""INSERT INTO publication_v1.previews
                 VALUES(%s,%s,%s,%s,%s,%s,%s,clock_timestamp() + interval '30 minutes')
                 ON CONFLICT(library_ref,preview_ref) DO UPDATE
                 SET expires_at=EXCLUDED.expires_at WHERE publication_v1.previews.expires_at < clock_timestamp()""",
              [library, preview, base, actor, target, checksum, Jsonb(plan)])
            expires = q("SELECT expires_at FROM publication_v1.previews WHERE library_ref=%s AND preview_ref=%s",
                        [library, preview]).fetchone()["expires_at"]
        return dict(preview_ref=preview, base_view_revision=base, review_ref=current.get("review_ref"),
                    expires_at=expires.isoformat(), **{key: plan[key] for key in ("before", "after", "impact")})

    def save(self, library, actor, target, request, *, revert=False):
        operation = request["client_operation_ref"]
        base = request["base_view_revision"]
        checksum = digest([target, revert, _request_sha(request)])
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            assert_workspace_writable(self.store, q, library)
            deferred = q("SELECT * FROM publication_v1.review_deferrals WHERE library_ref=%s AND request_ref=%s",
                         [library, operation]).fetchone()
            if deferred:
                require(deferred["request_sha"] == checksum and deferred["actor"] == actor, "OPERATION_KEY_CONFLICT")
                return self._defer_receipt(q, state, target), True
            old = q("SELECT * FROM publication_v1.decisions WHERE library_ref=%s AND request_ref=%s",
                    [library, operation]).fetchone()
            if old:
                require(old["request_sha"] == checksum and old["actor"] == actor, "OPERATION_KEY_CONFLICT")
                job = get_job(q, library, old["job_ref"]) if old["job_ref"] else None
                return Reader.decision_receipt(q, state, old, job), True
            assert_base(state, base)
            current = self._target(q, library, base, target, request, revert, state=state)
            if revert:
                active_revert = q("""SELECT 1 FROM publication_v1.decisions
                                     WHERE library_ref=%s AND supersedes=%s AND status='SAVED'""",
                                  [library, target]).fetchone()
                require(not active_revert, "DECISION_TARGET_CHANGED")
            review = current.get("review_ref")
            decision = ref("decision", library, operation)
            if not revert and request["intent"].get("kind") == "DEFER":
                intent = request["intent"]
                require(isinstance(intent.get("reason"), str) and intent["reason"].strip(),
                        "DEFER_REASON_REQUIRED", 422)
                q("INSERT INTO publication_v1.review_deferrals VALUES(%s,%s,%s,%s,%s,%s,%s)",
                  [library, review, base, operation, checksum, actor, Jsonb(intent)])
                event(q, library, "review.changed", {"review_ref": review, "review_status": "DEFERRED"}, view=base)
                return self._defer_receipt(q, state, review), False
            preview = q("""SELECT * FROM publication_v1.previews WHERE library_ref=%s AND preview_ref=%s
                           AND expires_at>clock_timestamp()""", [library, request.get("preview_ref")]).fetchone()
            require(preview, "PREVIEW_EXPIRED")
            require((preview["base_view_revision"], preview["actor"], preview["target_ref"], preview["request_sha"])
                    == (base, actor, target, _request_sha(request)), "PREVIEW_BASIS_MISMATCH")
            plan = preview["plan"]
            require(preview["preview_ref"] == ref("preview", library, target, actor,
                                                  _request_sha(request), digest(plan)), "PREVIEW_PLAN_DIGEST_MISMATCH")
            args = dict(plan["publication"], library_ref=library, base_view_revision=base,
                        trigger={"kind": "HUMAN_DECISION", "refs": [decision]},
                        request_ref=ref("decision_publication", library, decision))
            job = enqueue(q, args)
            row = q("""INSERT INTO publication_v1.decisions(library_ref,decision_ref,review_ref,basis_view_revision,
                       request_ref,request_sha,actor,request,plan,job_ref,status,supersedes)
                       VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'SAVED',%s) RETURNING *""",
                    [library, decision, review, base, operation, checksum, actor, Jsonb(request),
                     Jsonb(plan) if plan else None, job["job_ref"] if job else None, target if revert else None]).fetchone()
            receipt = Reader.decision_receipt(q, state, row, job)
            event(q, library, "decision.saved", receipt, job=receipt["job_ref"], view=base)
            event(q, library, "review.changed", {"review_ref": review, "review_status": receipt["review_status"]},
                  job=receipt["job_ref"], view=base)
            return receipt, False

    @staticmethod
    def _defer_receipt(q, state, review):
        return dict(Reader.decision_receipt(q, state, None, None), contract="ontoweave-decision-receipt/1",
                    review_ref=review, review_status="DEFERRED")

    def process(self, publisher, library, job):
        with self.store.transaction(readonly=True) as (q, _):
            decision = q("SELECT plan FROM publication_v1.decisions WHERE library_ref=%s AND job_ref=%s",
                         [library, job]).fetchone()
            require(decision and decision["plan"], "JOB_PLAN_UNAVAILABLE", 404)
            plan = decision["plan"]
        return publisher.apply(library, job, **{key: plan[key] for key in ("bundle", "graph_delta", "index_delta")},
                               redirects=plan.get("redirects", []), domains=plan.get("domains"))

    def feedback(self, library, actor, definition, request):
        require(request["definition_ref"] == definition, "FEEDBACK_DEFINITION_MISMATCH", 422)
        require(request["business_problem"].strip(), "BUSINESS_PROBLEM_REQUIRED", 422)
        operation, base = request["client_operation_ref"], request["base_view_revision"]
        checksum = digest(request)
        builder = getattr(self.plan_intent, "feedback_review", None)
        review = None
        if builder:
            with self.store.transaction(readonly=True) as (q, _):
                prior = q("SELECT * FROM publication_v1.feedback WHERE library_ref=%s AND operation_ref=%s",
                          [library,operation]).fetchone()
                if prior:
                    require(prior["request_sha"] == checksum and prior["actor"] == actor, "OPERATION_KEY_CONFLICT")
                    return prior["receipt"], True
                state = head(q, library)
                assert_base(state, base)
                adopted = manifest(q,library,base)
                facts = list(projection(q,library,base,("FACT",)).values())
            review = builder(adopted, request, facts)
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            assert_workspace_writable(self.store, q, library)
            old = q("""SELECT * FROM publication_v1.feedback WHERE library_ref=%s AND operation_ref=%s""",
                    [library, operation]).fetchone()
            if old:
                require(old["request_sha"] == checksum and old["actor"] == actor, "OPERATION_KEY_CONFLICT")
                return old["receipt"], True
            assert_base(state, base)
            rows = projection(q, library, base, ("DEFINITION", "FACT", "SOURCE"))
            item = rows.get(("DEFINITION", definition))
            require(item, "OBJECT_NOT_IN_VIEW", 404)
            require(all(("FACT", value) in rows for value in request["fact_refs"])
                    and all(("SOURCE", value) in rows for value in request["source_refs"]),
                    "FEEDBACK_CONTEXT_OUT_OF_VIEW", 422)
            body = dict(request, inherited_source_refs=item.get("source_refs", []))
            if review:
                require(review["target_kind"] == "ONTOLOGY" and
                        all(("SOURCE", value) in rows for value in review["source_refs"]),
                        "FEEDBACK_REVIEW_CONTEXT_OUT_OF_VIEW", 422)
                body["review"] = review
            receipt = dict(feedback_ref=ref("feedback", library, operation),
                           review_ref=review["review_ref"] if review else None,
                           needs_more_context=review is None, missing=[] if review else ["actionable_review_basis"])
            q("INSERT INTO publication_v1.feedback VALUES(%s,%s,%s,%s,%s,%s,%s)",
              [library, operation, checksum, base, actor, Jsonb(body), Jsonb(receipt)])
            if review:
                event(q,library,"review.changed",{"review_ref":review["review_ref"],"review_status":"OPEN"},view=base)
            return receipt, False
