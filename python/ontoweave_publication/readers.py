from base64 import b64decode, b64encode
from datetime import datetime, timezone

from .coordinator import _diff
from .store import digest, get_job, head, manifest, projection, require, review_context_views, review_rows, steps


def _read_view(q, library, specified=None):
    state = head(q, library)
    view = specified if specified is not None else state["active_view_revision"]
    require(view, "VIEW_NOT_PUBLISHED", 404)
    return manifest(q, library, view)


def _iso_time(value, code):
    try:
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(value.utcoffset() is not None, code, 422)
        return value
    except (ValueError, OverflowError):
        require(False, code, 422)


def _scope(at=None, as_of=None):
    return {"at": at, "as_of": as_of,
            "time_label": ("指定时间" if at else "全部时间") + " · " + ("历史认识" if as_of else "当前认识")}


def _page(items, signature, cursor, limit):
    offset = 0
    if cursor:
        try:
            value = b64decode(cursor.encode("ascii"), altchars=b"-_", validate=True).decode("ascii")
            key, number = value.split(":")
            offset = int(number)
            require(key == signature and 0 <= offset <= len(items), "CURSOR_INVALID", 422)
        except (ValueError, UnicodeError):
            require(False, "CURSOR_INVALID", 422)
    end = offset + limit
    next_cursor = b64encode(f"{signature}:{end}".encode(), altchars=b"-_").decode() if end < len(items) else None
    return items[offset:end], next_cursor


def _publication_status(status):
    return {"SUCCEEDED": "PUBLISHED", "FAILED": "FAILED", "CANCELLED": "NONE",
            "UNKNOWN_HOLD": "UNKNOWN_HOLD"}.get(status, "PREPARING")


class Reader:
    def __init__(self, store, *, world_time_filter=None, review_domains=None, runs_human_jobs=False,
                 query_registered=False, models=None):
        self.store = store
        self.world_time_filter = world_time_filter
        self.review_domains = review_domains
        self.runs_human_jobs = runs_human_jobs
        self.query_registered = query_registered
        self.models = models or {}

    @staticmethod
    def _publication_pending(q, state, view):
        if view != state["active_view_revision"]:
            return False
        return bool(state["pending_view_revision"] or q("""
            SELECT 1 FROM publication_v1.jobs j WHERE j.library_ref=%s AND (
                (j.base_view_revision=%s AND j.status IN ('QUEUED','RUNNING','UNKNOWN_HOLD'))
                OR (j.status='FAILED' AND j.request ? 'domain_plan_sha' AND EXISTS (
                    SELECT 1 FROM publication_v1.job_steps s
                    WHERE s.library_ref=j.library_ref AND s.job_ref=j.job_ref AND s.step='FACT'))
            ) LIMIT 1
            """, [state["library_ref"], view]).fetchone())

    def _visible_review(self, q, library, view, key, row, *, state, publication_pending):
        result = self._review_state(q, library, view, key, row, state=state)
        status, code, reason = self._review_eligibility(result, publication_pending)
        if status != "ACTIONABLE":
            result["available_actions"] = []
        result["review_eligibility"] = dict(status=status, reason_code=code, reason=reason,
                                           actionable=status == "ACTIONABLE" and result["review_status"] == "OPEN")
        if result["target_kind"] == "IDENTITY":
            suggestion = result.get("judgment") or {}
            result.setdefault("model_suggestion", dict(
                judgment=suggestion.get("judgment"), confidence=None,
                confidence_status="LEGACY_UNSCORED" if suggestion else "NOT_APPLICABLE",
                reason=suggestion.get("reason"), evidence_refs=suggestion.get("evidence_refs", []),
                contract=suggestion.get("contract")))
            result.setdefault("adoption", dict(status="NOT_EVALUATED", reason_code=None,
                                              reason=None, impact=None, policy=None))
        return result

    def _review_eligibility(self, result, publication_pending):
        if result["read_only"]:
            return "HISTORICAL", "REVIEW_HISTORICAL_VIEW", "当前查看的是历史版本。"
        if result["review_status"] not in {"OPEN", "DEFERRED"}:
            return "CLOSED", "REVIEW_DECISION_RECORDED", "已保存处理决定，可查看决定及应用状态。"
        if self.review_domains is not None and result["target_kind"] not in self.review_domains:
            return "DOMAIN_DISABLED", "DECISION_DOMAIN_UNAVAILABLE", "此服务尚未启用该类事项的人工处理。"
        if not self.runs_human_jobs:
            return "WORKER_DISABLED", "HUMAN_JOB_WORKER_UNAVAILABLE", "此服务尚未启用人工决定的应用流程。"
        if publication_pending:
            return "PUBLICATION_PENDING", "REVIEW_PUBLICATION_PENDING", "有发布任务正在等待确认，请在发布状态更新后重读事项。"

        domain = result.get("review_eligibility") or {}
        if domain.get("status") in {"WAITING_FOR_EVIDENCE", "TECHNICAL_PENDING", "NO_LEGAL_ACTION"}:
            return domain["status"], domain.get("reason_code"), domain.get("reason")

        kinds = {action["kind"] for action in result["available_actions"]}
        if result["target_kind"] == "IDENTITY":
            if result.get("identity_status") == "TECHNICAL_PENDING":
                return "TECHNICAL_PENDING", "IDENTITY_CHECKS_UNAVAILABLE", "实体影响检查暂不可用。"
            sides = result.get("sides", [])
            if len(sides) != 2 or not all(
                any(item.get("source_ref") and item.get("statement_ref") and item.get("occurrence_ref")
                    and item.get("statement_excerpt") and (item.get("text") or item.get("preview")
                         or (item.get("location") or {}).get("text")) for item in side.get("evidence", []))
                for side in sides
            ):
                return "WAITING_FOR_EVIDENCE", "IDENTITY_BILATERAL_MATERIAL_UNAVAILABLE", "双方的具体陈述及来源材料还未齐备。"
            kinds &= {"MERGE", "KEEP_SEPARATE"}
        if not kinds - {"DEFER"}:
            return "NO_LEGAL_ACTION", "REVIEW_NO_LEGAL_ACTION", "当前没有可应用的处理方式。"
        return "ACTIONABLE", None, None

    def _world_rows(self, library, adopted, rows, at):
        if at is None:
            return rows
        require(self.world_time_filter, "WORLD_TIME_FILTER_UNAVAILABLE", 422)
        return self.world_time_filter(library, adopted, rows, at)

    def _capabilities(self, adopted):
        from ontoweave_product.capabilities import workspace_capabilities

        return dict(workspace_capabilities(
            adopted["index_components"] if adopted else None, query_registered=self.query_registered,
            query_descriptor=bool((adopted or {}).get("index_descriptor_ref")), models=self.models),
            human_review_domains=sorted(self.review_domains or ()), runs_human_jobs=self.runs_human_jobs,
            generation_mode="OFF")

    def capabilities(self, library):
        with self.store.transaction(readonly=True) as (q, _):
            active = head(q, library)["active_view_revision"]
            return self._capabilities(manifest(q, library, active) if active else None)

    def workspace(self, library):
        with self.store.transaction(readonly=True) as (q, _):
            state = head(q, library)
            active = state["active_view_revision"]
            adopted = manifest(q, library, active) if active else None
            rows = {**projection(q, library, active, ("FACT", "STATEMENT")), **review_rows(q,library,active)}
            latest = q("""SELECT * FROM publication_v1.jobs WHERE library_ref=%s
                          ORDER BY created_at DESC,job_ref DESC LIMIT 1""", [library]).fetchone()
            status = _publication_status(latest["status"]) if latest else "NONE"
            target = (dict(publication_status=status, job_ref=latest["job_ref"], failure=latest["failure"],
                           run_ref=latest["request"].get("run_ref"),
                           target_view_revision=latest["target_view_revision"]) if latest else None)
            counts = dict(standard_facts=0, open_statements=0, contested_facts=0,
                          open_reviews=0, unavailable_open_reviews=0, pending_jobs=0)
            pending = self._publication_pending(q, state, active) if active else False
            for (kind, key), body in rows.items():
                if kind == "STATEMENT" and body.get("routing_result") == "OPEN_UNINTERPRETED":
                    counts["open_statements"] += 1
                if kind == "FACT":
                    counts["standard_facts"] += 1
                    counts["contested_facts"] += body.get("state") == "CONTESTED"
                if kind == "REVIEW":
                    review = self._visible_review(q, library, active, key, body, state=state,
                                                  publication_pending=pending)
                    if review["review_status"] == "OPEN":
                        counter = "open_reviews" if review["review_eligibility"]["actionable"] else "unavailable_open_reviews"
                        counts[counter] += 1
            counts["pending_jobs"] = q("""SELECT count(*) AS n FROM publication_v1.jobs WHERE library_ref=%s
                                          AND status IN ('QUEUED','RUNNING','UNKNOWN_HOLD')""", [library]).fetchone()["n"]
            return dict(library_ref=library, view_revision=active, active_view=adopted,
                        target_publication=target, execution_status=(latest["request"].get("execution_status")
                                                                    if latest else None),
                        publication_status=status, counts=counts, gaps=(adopted or {}).get("gaps", []),
                        available_actions=[],
                        capabilities=self._capabilities(adopted))

    def resolve(self, library, *, at=None, as_of=None, view_revision=None):
        require(not (as_of and view_revision), "SYSTEM_SCOPE_AMBIGUOUS", 422)
        inspection_time = _iso_time(as_of, "AS_OF_TIME_INVALID") if as_of else None
        now = datetime.now(timezone.utc)
        if at == "current":
            at = now.isoformat()
        if at:
            _iso_time(at, "WORLD_TIME_INVALID")
            require(self.world_time_filter, "WORLD_TIME_FILTER_UNAVAILABLE", 422)
        with self.store.transaction(readonly=True) as (q, _):
            if inspection_time:
                db_now = q("SELECT clock_timestamp() AS current").fetchone()["current"]
                require(inspection_time <= db_now, "HISTORY_BOUNDARY_UNAVAILABLE", 422)
                ambiguous = q("""SELECT 1 FROM publication_v1.manifests m
                                 LEFT JOIN publication_v1.confirmations c USING(library_ref,view_revision)
                                 WHERE m.library_ref=%s AND m.staged_at<=%s
                                   AND (c.activated_at IS NULL OR %s<c.activated_at)
                                 LIMIT 1""", [library, inspection_time, inspection_time]).fetchone()
                require(not ambiguous, "HISTORY_BOUNDARY_UNAVAILABLE", 422)
                row = q("""SELECT c.view_revision FROM publication_v1.confirmations c
                           JOIN publication_v1.manifests m USING(library_ref,view_revision)
                           WHERE c.library_ref=%s AND c.activated_at<=%s
                           ORDER BY c.activated_at DESC,m.activation_seq DESC LIMIT 1""",
                        [library, inspection_time]).fetchone()
                require(row, "HISTORY_BOUNDARY_UNAVAILABLE", 422)
                view_revision = row["view_revision"]
            adopted = _read_view(q, library, view_revision)
        return dict(view_revision=adopted["view_revision"], resolved_scope=_scope(at, as_of),
                    read_only=bool(view_revision or as_of))

    def graph(self, library, view_revision=None, at=None, cursor=None, limit=200):
        require(at != "current", "RESOLVE_WORLD_TIME_FIRST", 422)
        if at:
            _iso_time(at, "WORLD_TIME_INVALID")
        with self.store.transaction(readonly=True) as (q, _):
            adopted = _read_view(q, library, view_revision)
            view = adopted["view_revision"]
            rows = self._world_rows(library, adopted, projection(q, library, view, ("NODE", "EDGE", "FACT")), at)
        nodes = {key: row for (kind, key), row in rows.items() if kind == "NODE"}
        edges = {key: row for (kind, key), row in rows.items() if kind == "EDGE"}
        items = [("NODE", key, row) for key, row in sorted(nodes.items())]
        items.extend(("EDGE", key, row) for key, row in sorted(edges.items()))
        signature = digest([library, view, at, limit, "graph"])
        page, next_cursor = _page(items, signature, cursor, limit)
        returned_nodes, returned_edges = {}, []
        node_count = len(nodes)
        for kind, key, row in page:
            if kind == "NODE":
                returned_nodes[key] = row
            else:
                returned_edges.append(row)
                for ref in (row["source"], row["target"]):
                    returned_nodes[ref] = nodes[ref]
        return dict(view_revision=view, scope=_scope(at), publication_status="PUBLISHED",
                    coverage=adopted["coverage"], gaps=adopted["gaps"],
                    graph=dict(nodes=list(returned_nodes.values()), edges=returned_edges),
                    summary=dict(total_nodes=node_count, total_edges=len(edges), returned_nodes=len(returned_nodes),
                                 returned_edges=len(returned_edges)),
                    selection=dict(truncated=bool(cursor or next_cursor), next_cursor=next_cursor))

    def delta(self, library, previous, next_view, at=None):
        require(previous and next_view, "DELTA_VIEW_REQUIRED", 422)
        if at:
            _iso_time(at, "WORLD_TIME_INVALID")
        with self.store.transaction(readonly=True) as (q, _):
            old = _read_view(q, library, previous)
            new = _read_view(q, library, next_view)
            require(new["parent_view_revision"] == old["view_revision"], "DELTA_UNAVAILABLE", 409)
            row = q("SELECT body FROM publication_v1.changes WHERE library_ref=%s AND view_revision=%s",
                    [library, next_view]).fetchone()
            require(row, "DELTA_UNAVAILABLE", 409)
            result = row["body"]
            if at:
                before, after = (self._world_rows(library, value, projection(q, library, value["view_revision"],
                                                                       ("NODE","EDGE","FACT","DEFINITION")), at)
                                 for value in (old, new))
                result.update(_diff(before, after, result["entity_redirects"]), scope=_scope(at))
            impact = sum(len(values) for section in ("added", "updated", "removed")
                         for values in result[section].values())
            require(impact <= 1000, "DELTA_UNAVAILABLE", 409)
            return result

    def record(self, library, kind, key, view_revision=None, at=None):
        with self.store.transaction(readonly=True) as (q, _):
            adopted = _read_view(q, library, view_revision)
            view = adopted["view_revision"]
            if at:
                _iso_time(at, "WORLD_TIME_INVALID")
            rows = review_rows(q,library,view) if kind == "REVIEW" else projection(q, library, view, (kind,))
            rows = self._world_rows(library, adopted, rows, at)
            detail = rows.get((kind, key))
            require(detail, "SOURCE_NOT_IN_VIEW" if kind == "SOURCE" else "OBJECT_NOT_IN_VIEW", 404)
            if kind == "REVIEW":
                state = head(q, library)
                return self._visible_review(q, library, view, key, detail, state=state,
                                            publication_pending=self._publication_pending(q, state, view))
            if kind == "DEFINITION":
                detail = self._definition_phrases(q, library, detail)
            return dict(detail, view_revision=view)

    @staticmethod
    def _definition_phrases(q, library, detail):
        bindings = detail.get("bindings", [])
        if not bindings:
            return detail
        references = [binding["alignment_signature_ref"] for binding in bindings]
        signatures = q("""SELECT signature_ref,basis_sha256,payload FROM ontology_v1.alignment_signatures
                          WHERE library_ref=%s AND signature_ref=ANY(%s)""", [library,references]).fetchall()
        lookup = {(row["signature_ref"],row["basis_sha256"]):row["payload"] for row in signatures}
        observed = []
        for binding in bindings:
            key = (binding["alignment_signature_ref"],binding["basis_sha256"])
            group = lookup.get(key, {})
            evidence = set(binding.get("evidence_statement_refs", []))
            phrases = sorted({row["surface"] for row in group.get("members", [])
                              if row["target"]["statement_ref"] in evidence and row["surface"]})
            observed.extend(dict(binding, phrase=phrase) for phrase in phrases)
            if not phrases:
                observed.append(binding)
        return dict(detail, bindings=observed)

    def list(self, library, kind, view_revision=None, cursor=None, limit=100, status=None):
        with self.store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library, view_revision)["view_revision"]
            items = review_rows(q,library,view) if kind == "REVIEW" else projection(q, library, view, (kind,))
            counts = None
            if kind == "REVIEW":
                state = head(q, library)
                pending = self._publication_pending(q, state, view)
                items = {k: self._visible_review(q, library, view, k[1], row, state=state,
                                                publication_pending=pending) for k, row in items.items()}
                counts = dict(open=0, unavailable_open=0, deferred=0, pending_application=0)
                for row in items.values():
                    actionable = row["review_eligibility"]["actionable"]
                    counts["open"] += actionable
                    counts["unavailable_open"] += row["review_status"] == "OPEN" and not actionable
                    counts["deferred"] += row["review_status"] == "DEFERRED"
                    counts["pending_application"] += (row.get("decision") or {}).get("decision_status") == "SAVED"
            results = [row for _, row in sorted(items.items()) if not status or row["review_status"] == status]
            signature = [library, kind, view, status, limit]
            if kind == "REVIEW" and status == "OPEN":
                results = [row for row in results if row["read_only"] or row["review_eligibility"]["actionable"]]
                signature.append([row["review_ref"] for row in results])
            results, next_cursor = _page(results, digest(signature), cursor, limit)
        response = dict(view_revision=view, items=results, next_cursor=next_cursor)
        if counts is not None:
            response["counts"] = counts
        return response

    def document_scope(self, q, library, view, source):
        return None

    def knowledge(self, library, view_revision=None, kind=None, source_ref=None, cursor=None, limit=100):
        with self.store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library, view_revision)["view_revision"]
            kinds = ("FACT", "STATEMENT") if kind is None else ("FACT",) if kind == "FACT" else ("STATEMENT",)
            rows = projection(q, library, view, (*kinds, "SOURCE") if source_ref else kinds)
            allowed_sources = {source_ref} if source_ref else None
            if source_ref:
                document = self.document_scope(q, library, view, source_ref)
                require(document or ("SOURCE", source_ref) in rows, "SOURCE_NOT_FOUND", 404)
                if document:
                    for (row_kind, key), row in rows.items():
                        if row_kind != "SOURCE":
                            continue
                        location = row.get("location") or {}
                        binding = (location.get("doc_ref") or row.get("doc_ref"),
                                   location.get("revision") or row.get("revision"))
                        if binding == document:
                            allowed_sources.add(key)
            items = []
            for (row_kind, key), row in sorted(rows.items()):
                if row_kind == "SOURCE" or (row_kind == "STATEMENT" and row["routing_result"] != "OPEN_UNINTERPRETED"):
                    continue
                if allowed_sources is not None and not allowed_sources.intersection(row.get("source_refs", [])):
                    continue
                items.append(dict(row, knowledge_ref=key, kind="FACT" if row_kind == "FACT" else "OPEN"))
            items, next_cursor = _page(items, digest([library, view, kind, source_ref, limit]), cursor, limit)
            return dict(view_revision=view, items=items, next_cursor=next_cursor)

    def index(self, library, query, view_revision=None, limit=100):
        with self.store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library, view_revision)["view_revision"]
            rows = projection(q, library, view, ("ENTITY_NAME", "FACT_LEXICAL", "SOURCE_LEXICAL"))
            return dict(view_revision=view, documents=[
                {"component": kind.lower(), **row} for (kind, _), row in sorted(rows.items())
                if query.casefold() in row["text"].casefold()][:limit])

    def change(self, library, change):
        with self.store.transaction(readonly=True) as (q, _):
            row = q("""SELECT h.body,d.decision_ref,d.status,d.request FROM publication_v1.changes h
                       JOIN publication_v1.confirmations c USING (library_ref,view_revision)
                       JOIN publication_v1.manifests m USING (library_ref,view_revision)
                       LEFT JOIN publication_v1.decisions d USING (library_ref,job_ref)
                       WHERE h.library_ref=%s AND h.change_ref=%s""", [library, change]).fetchone()
            require(row, "CHANGE_NOT_FOUND", 404)
            body = row["body"]
            affected = body["affected_fact_refs"]
            before, after = (projection(q, library, view, ("FACT",))
                             for view in (body["from"], body["to"]))
            request = row["request"] or {}
            current = head(q,library)["active_view_revision"]
            reversible = (row["status"] == "APPLIED" and self.runs_human_jobs
                          and (self.review_domains is None or "FACT" in self.review_domains)
                          and request.get("intent", {}).get("kind") == "KEEP_BOTH" and current == body["to"])
            return dict(body, decision_ref=row["decision_ref"], available_actions=["REVERT"] if reversible else [],
                        before={"facts": [before["FACT", key] for key in affected if ("FACT", key) in before]},
                        after={"facts": [after["FACT", key] for key in affected if ("FACT", key) in after]})

    def job(self, library, job):
        with self.store.transaction(readonly=True) as (q, _):
            info = get_job(q, library, job)
            state = head(q, library)
            step_receipts = steps(q, library, job)
            decision = q("SELECT * FROM publication_v1.decisions WHERE library_ref=%s AND job_ref=%s",
                         [library, job]).fetchone()
            response = self.decision_receipt(q, state, decision, info)
            response.update(step=next((name for name in ("INDEX", "GRAPH", "FACT") if name in step_receipts), None),
                            step_receipts=list(step_receipts.values()), failure=info["failure"], available_actions=[])
            if info["status"] == "UNKNOWN_HOLD":
                response["available_actions"] = ["RECONCILE"]
            return response

    @staticmethod
    def decision_receipt(q, state, decision, job):
        status = job["status"] if job else None
        target = job["target_view_revision"] if job else None
        change = q("SELECT change_ref FROM publication_v1.changes WHERE library_ref=%s AND view_revision=%s",
                   [state["library_ref"], target]).fetchone() if status == "SUCCEEDED" else None
        return dict(contract="ontoweave-decision-receipt/1" if decision else "ontoweave-job-receipt/1",
                    decision_ref=decision["decision_ref"] if decision else None,
                    client_operation_ref=decision["request_ref"] if decision else None,
                    decision_status=decision["status"] if decision else None,
                    review_status=("DECIDED" if job else "DEFERRED") if decision else None,
                    job_ref=job["job_ref"] if job else None, job_status=status,
                    publication_status=_publication_status(status) if job else "NONE",
                    active_view_revision=state["active_view_revision"],
                    target_view_revision=target, change_ref=change["change_ref"] if change else None)

    @staticmethod
    def _review_state(q, library, view, key, detail, *, state):
        active = view == state["active_view_revision"]
        decision = q("""SELECT * FROM publication_v1.decisions
                        WHERE library_ref=%s AND review_ref=%s AND basis_view_revision=%s AND status='SAVED'""",
                     [library, key, view]).fetchone() if active else None
        deferred = q("""SELECT 1 FROM publication_v1.review_deferrals
                        WHERE library_ref=%s AND review_ref=%s AND basis_view_revision=ANY(%s) LIMIT 1""",
                     [library, key, review_context_views(q, library, view)]).fetchone()
        status = ("DECIDED" if decision else "DEFERRED" if deferred else detail.get("review_status", "OPEN"))
        decision_ref = detail.get("decision_ref")
        if decision is None and decision_ref and status == "DECIDED":
            decision = q("SELECT * FROM publication_v1.decisions WHERE library_ref=%s AND decision_ref=%s",
                         [library, decision_ref]).fetchone()
            if decision:
                decision = dict(decision, status="APPLIED")
        saved = Reader.decision_receipt(q, state, decision, get_job(q, library, decision["job_ref"])) if decision else None
        return dict(detail, view_revision=view, base_view_revision=view, read_only=not active,
                    review_status=status, decision=saved, decision_receipt=saved,
                    available_actions=[action for action in detail.get("available_actions", [])
                                       if active and (status == "OPEN" or
                                                     status == "DEFERRED" and action["kind"] != "DEFER")])

    def events(self, library, cursor, limit=100):
        with self.store.transaction(readonly=True) as (q, _):
            head(q, library)
            number = 0
            if cursor:
                exists = q("SELECT stream_seq FROM publication_v1.outbox WHERE library_ref=%s AND stream_seq::text=%s",
                           [library, cursor]).fetchone()
                if not exists:
                    return None
                number = exists["stream_seq"]
            rows = q("""SELECT * FROM publication_v1.outbox WHERE library_ref=%s AND stream_seq>%s
                        ORDER BY stream_seq LIMIT %s""", [library, number, limit]).fetchall()
        return [dict(event_id=str(row["stream_seq"]), library_ref=library, event_type=row["event_type"],
                     run_ref=row["run_ref"], job_ref=row["job_ref"], view_revision=row["view_revision"],
                     change_ref=row["change_ref"], occurred_at=row["occurred_at"].isoformat(),
                     payload=row["payload"]) for row in rows]
