from psycopg import InterfaceError, OperationalError
from psycopg.types.json import Jsonb

from .store import (
    PublicationError, assert_base, digest, event, get_job, head, manifest, projection, ref, require, steps,
)

GRAPH_KINDS = ("NODE", "EDGE", "STATEMENT", "SOURCE", "FACT", "DEFINITION", "REVIEW")
INDEX_KINDS = ("ENTITY_NAME", "FACT_LEXICAL", "SOURCE_LEXICAL", "FACT_VECTOR", "SOURCE_VECTOR")
INDEX_COMPONENTS = {kind.lower(): ("READY" if kind in INDEX_KINDS[:3] else "NOT_CONFIGURED")
                    for kind in INDEX_KINDS}
TARGET_KEYS = ("identity_revision", "ontology_revision", "time_revision", "fact_revision")


def enqueue(q, request):
    library, operation = request["library_ref"], request["request_ref"]
    source = request.get("source_manifest_ref")
    require(all(isinstance(value, str) and value for value in (library, operation, source)),
            "PUBLICATION_REQUEST_INVALID", 422)
    state = head(q, library, lock=True)
    fingerprint = digest(request)
    old = q("SELECT * FROM publication_v1.jobs WHERE library_ref=%s AND request_ref=%s",
            [library, operation]).fetchone()
    if old:
        require(old["input_sha"] == fingerprint, "OPERATION_KEY_CONFLICT")
        return old
    require(request.get("contract") == "ontoweave-publication-input/1"
            and request.get("coverage") in {"FULL", "PARTIAL"}
            and (request["coverage"] == "PARTIAL") == bool(request["gaps"])
            and all(request["target_revisions"].get(key) for key in TARGET_KEYS)
            and request.get("fact_bundle_ref"), "PUBLICATION_REQUEST_INVALID", 422)
    base = request["base_view_revision"]
    assert_base(state, base)
    job = ref("job", library, operation)
    row = q("""INSERT INTO publication_v1.jobs(library_ref,job_ref,request_ref,input_sha,base_view_revision,status,request)
               VALUES(%s,%s,%s,%s,%s,'QUEUED',%s) RETURNING *""",
            [library, job, operation, fingerprint, base, Jsonb(request)]).fetchone()
    event(q, library, "job.progress", {"job_status": "QUEUED", "step": None},
          run=request.get("run_ref"), job=job)
    return row


def _apply_delta(current, delta, kinds):
    updated = current.copy()
    for kind, entries in delta.items():
        require(kind in kinds and isinstance(entries, dict), "PROJECTION_KIND_INVALID", 422)
        for key, body in entries.items():
            require(isinstance(key, str) and key and (body is None or isinstance(body, dict)),
                    "PROJECTION_ROW_INVALID", 422)
            if body is None:
                updated.pop((kind, key), None)
            else:
                updated[(kind, key)] = body
    return updated


def _validate_graph(rows):
    def contains(kind, keys):
        return all((kind, key) in rows for key in keys)
    for (kind, key), body in rows.items():
        valid = True
        if kind == "NODE":
            valid = body.get("id") == key and contains("DEFINITION", body.get("type_refs", []))
        elif kind == "EDGE":
            valid = body.get("id") == key and contains("NODE", [body.get("source"), body.get("target")])
            if body.get("fact_ref"):
                valid = valid and contains("FACT", [body["fact_ref"]])
            elif body.get("statement_ref"):
                valid = valid and contains("STATEMENT", [body["statement_ref"]])
            else:
                valid = False
        if kind in {"FACT", "REVIEW", "DEFINITION", "STATEMENT"}:
            valid = valid and contains("SOURCE", body.get("source_refs", []))
        if kind == "FACT":
            valid = (valid and body.get("fact_ref") == key and body.get("fact_version_ref")
                     and contains("STATEMENT", body.get("statement_refs", []))
                     and contains("DEFINITION", [body.get("definition_ref")]))
        require(valid, "GRAPH_REFERENCE_UNCLOSED", 422, kind=kind, object_ref=key)


def _validate_index(rows, graph):
    matching = {"ENTITY_NAME": "NODE", "FACT_LEXICAL": "FACT", "SOURCE_LEXICAL": "SOURCE"}
    for kind, target in matching.items():
        expected = {key for (category, key) in graph if category == target}
        actual = {key for (category, key), value in rows.items()
                  if category == kind and value.get("object_ref") == key and isinstance(value.get("text"), str)}
        require(actual == expected, "INDEX_SCOPE_INCOMPLETE", 422, component=kind.lower())
    require(not any(kind in INDEX_KINDS[3:] for kind, _ in rows), "VECTOR_NOT_CONFIGURED", 422)


def _write_delta(q, library, job, delta, base_rows):
    affected = []
    for kind, entries in sorted(delta.items()):
        for key, body in sorted(entries.items()):
            if base_rows.get((kind, key)) == body:
                continue
            q("""INSERT INTO publication_v1.projection_delta VALUES(%s,%s,%s,%s,%s)""",
              [library, job, kind, key, Jsonb(body) if body is not None else None])
            affected.append([kind, key])
    return affected


def _row_digest(rows):
    return digest([[kind, key, row] for (kind, key), row in sorted(rows.items())])


def _diff(before, after, redirects):
    result = dict(added=dict(nodes=[], edges=[]), updated=dict(nodes=[], edges=[]),
                  removed=dict(node_refs=[], edge_refs=[]), entity_redirects=redirects,
                  affected_fact_refs=[], affected_definition_refs=[], affected_review_refs=[], before_after_available=True)
    for kind, key in sorted(before.keys() | after.keys()):
        old, new = before.get((kind, key)), after.get((kind, key))
        if old == new:
            continue
        if kind == "FACT":
            result["affected_fact_refs"].append(key)
        elif kind == "DEFINITION":
            result["affected_definition_refs"].append(key)
        elif kind == "REVIEW":
            result["affected_review_refs"].append(key)
        elif kind in {"NODE", "EDGE"}:
            if new is None:
                result["removed"][kind.lower() + "_refs"].append(key)
            else:
                result["added" if old is None else "updated"][kind.lower() + "s"].append(new)
    return result


class Publisher:
    """Owns job state, transaction sequencing and the sole public adoption pointer."""

    def __init__(self, store, apply_fact_bundle, *, activate_identity=None, stage_domains=None):
        self.store = store
        self.apply_fact_bundle = apply_fact_bundle
        self.activate_identity = activate_identity
        self.stage_domains = stage_domains

    def register(self, library):
        require(isinstance(library, str) and library, "LIBRARY_REF_INVALID", 422)
        from ontoweave_identity.storage import lock_publication_owner

        with self.store.transaction() as (q, _):
            lock_publication_owner(q, library)
            q("INSERT INTO publication_v1.libraries(library_ref) VALUES(%s) ON CONFLICT DO NOTHING", [library])

    def submit(self, request):
        with self.store.transaction() as (q, _):
            return enqueue(q, request)["job_ref"]

    def adopt_index(self, library, base_view, prepared, *, operation_ref):
        """Publish an index for exactly the current confirmed business snapshot."""
        from ontoweave_index.repository import publication_for_view, validate_prepared

        with self.store.transaction(readonly=True) as (q, _):
            base = manifest(q, library, base_view)
            graph = projection(q, library, base_view, GRAPH_KINDS)
            request = publication_for_view(base)
            validate_prepared(q, request, graph, prepared)
        gaps = [gap for gap in base["gaps"] if gap.get("domain") != "RETRIEVAL_INDEX"]
        request.update(contract="ontoweave-publication-input/1", request_ref=operation_ref,
                       trigger={"kind": "INDEX_REFRESH", "refs": [base_view]}, run_ref=None,
                       fact_bundle_ref=base["fact_bundle_ref"], prepared_index=prepared,
                       retrieval_index_required=True, coverage="PARTIAL" if gaps else "FULL", gaps=gaps)
        job = self.submit(request)
        return self.apply(library, job, bundle=None, graph_delta={}, index_delta={})

    def _step(self, library, job, name, input_sha, work):
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            info = get_job(q, library, job)
            require(info["status"] not in {"UNKNOWN_HOLD", "CANCELLED"}, "JOB_NOT_RESUMABLE")
            old = steps(q, library, job).get(name)
            if old:
                require(old["input_sha"] == input_sha, "STEP_INPUT_CHANGED")
                return old["receipt"]
            assert_base(state, info["base_view_revision"])
            sibling = q("""SELECT j.job_ref FROM publication_v1.jobs j
                           WHERE j.library_ref=%s AND j.job_ref<>%s
                             AND (j.status IN ('RUNNING','UNKNOWN_HOLD')
                                  OR (j.status='FAILED' AND j.request ? 'domain_plan_sha' AND EXISTS (
                                      SELECT 1 FROM publication_v1.job_steps s
                                      WHERE s.library_ref=j.library_ref AND s.job_ref=j.job_ref AND s.step='FACT')))
                           LIMIT 1""", [library,job]).fetchone()
            require(not sibling, "JOB_APPLICATION_IN_PROGRESS")
            receipt = work(q, info)
            q("INSERT INTO publication_v1.job_steps VALUES(%s,%s,%s,%s,%s,%s)",
              [library, job, name, input_sha, digest(receipt), Jsonb(receipt)])
            q("""UPDATE publication_v1.jobs SET status='RUNNING',failure=NULL
                 WHERE library_ref=%s AND job_ref=%s""", [library, job])
            event(q, library, "job.progress", {"job_status": "RUNNING", "step": name},
                  run=info["request"].get("run_ref"), job=job)
            return receipt

    def apply(self, library, job, *, bundle, graph_delta, index_delta, redirects=(), domains=None):
        try:
            return self._apply(library, job, bundle, graph_delta, index_delta, list(redirects), domains)
        except (OperationalError, InterfaceError) as exc:
            self._fail(library, job, "UNKNOWN_HOLD", {"code": "COMMIT_UNKNOWN"})
            raise PublicationError("COMMIT_UNKNOWN", 503, {"job_ref": job}) from exc
        except PublicationError as exc:
            if exc.code in {"EMBEDDING_OUTCOME_UNKNOWN", "EMBEDDING_IN_FLIGHT_OR_UNKNOWN"}:
                self._fail(library, job, "UNKNOWN_HOLD", {"code": exc.code, **exc.details})
            elif exc.code not in {"JOB_NOT_RESUMABLE", "JOB_NOT_FOUND", "LIBRARY_NOT_FOUND", "JOB_APPLICATION_IN_PROGRESS"}:
                self._fail(library, job, "FAILED", {"code": exc.code, **exc.details})
            raise
        except Exception as exc:
            self._fail(library, job, "FAILED", {"code": getattr(exc, "code", type(exc).__name__)})
            raise

    def _apply(self, library, job, bundle, graph_delta, index_delta, redirects, domains):
        with self.store.transaction(readonly=True) as (q, _):
            info = get_job(q, library, job)
            base = info["base_view_revision"]
            request = info["request"]
            previous = projection(q, library, base, GRAPH_KINDS)
            old_index = projection(q, library, base, INDEX_KINDS)
        fingerprint = digest(request)
        require(fingerprint == info["input_sha"], "JOB_DIGEST_MISMATCH", 503)
        if request["trigger"]["kind"] == "INDEX_REFRESH":
            require(bundle is None and not (graph_delta or index_delta or redirects or domains),
                    "INDEX_REFRESH_BUSINESS_MUTATION", 422)
            return self._apply_index_refresh(library, job, request, previous, old_index)
        require(bundle["bundle_ref"] == request["fact_bundle_ref"] and
                bundle["body_sha"] == request["fact_bundle_sha"], "FACT_BUNDLE_REF_MISMATCH", 422)
        graph = _apply_delta(previous, graph_delta, GRAPH_KINDS)
        index = _apply_delta(old_index, index_delta, INDEX_KINDS)
        prepared = request.get("prepared_index")
        if request.get("retrieval_index_required"):
            from ontoweave_index.publication import PublicationIndex
            from ontoweave_index.repository import validate_prepared

            if prepared is None:
                service = getattr(self.store, "retrieval_preparer", None) or PublicationIndex(self.store)
                prepared = service.prepare_job(library, job, request, graph)
            with self.store.transaction(readonly=True) as (q, _):
                validate_prepared(q, request, graph, prepared)
        require(prepared is None or request.get("retrieval_index_required"), "INDEX_NOT_REQUESTED", 422)
        targets = request["target_revisions"]
        require(request.get("domain_plan_sha") == (digest(domains) if domains is not None else None),
                "DOMAIN_PLAN_DIGEST_MISMATCH")
        require(domains is None or self.stage_domains, "DOMAIN_STAGE_ADAPTER_UNAVAILABLE", 503)

        def apply_facts(q, _info):
            context = dict(library_ref=library, base_view_revision=base,
                           identity_revision=targets["identity_revision"],
                           ontology_alignment_ref=targets["ontology_revision"],
                           time_revision=targets["time_revision"], source_manifest_ref=request["source_manifest_ref"],
                           target_fact_revision=targets["fact_revision"],
                           base_fact_revisions=request.get("base_fact_revisions", []))
            domain_receipts = self.stage_domains(q, context, domains, bundle) if domains is not None else None
            receipt = self.apply_fact_bundle(q, context, bundle)
            require(receipt["bundle_ref"] == bundle["bundle_ref"] and receipt["body_sha"] == bundle["body_sha"]
                    and receipt["fact_revision"] == targets["fact_revision"], "FACT_RECEIPT_MISMATCH", 422)
            if domain_receipts is not None:
                receipt = {**receipt, "domain_receipts":domain_receipts}
            return receipt

        fact = self._step(library, job, "FACT", digest([fingerprint, bundle["body_sha"]]), apply_facts)

        def save_graph(q, _info):
            _validate_graph(graph)
            settled = {record["statement_ref"] for record in fact["statement_results"]}
            supplied = {key for kind, key in graph if kind == "STATEMENT"}
            require(set(request["scope"]["statement_refs"]) <= settled <= supplied,
                    "STATEMENT_COVERAGE_INCOMPLETE", 422)
            return {"revision": ref("graph", library, job, _row_digest(graph)), "snapshot_sha": _row_digest(graph),
                    "affected": _write_delta(q, library, job, graph_delta, previous)}

        graph_receipt = self._step(library, job, "GRAPH", digest([fact, graph_delta]), save_graph)

        def save_index(q, _info):
            _validate_index(index, graph)
            receipt = {"revision": ref("index", library, job, _row_digest(index)), "snapshot_sha": _row_digest(index),
                       "affected": _write_delta(q, library, job, index_delta, old_index),
                       "components": INDEX_COMPONENTS}
            if prepared:
                from ontoweave_index.repository import retrieval_gaps

                descriptor = validate_prepared(q, request, graph, prepared)
                receipt.update(revision=descriptor["index_revision"],
                               components={**INDEX_COMPONENTS, **descriptor["components"]},
                               index_descriptor_ref=descriptor["index_descriptor_ref"],
                               index_descriptor_sha256=prepared["descriptor_sha256"],
                               retrieval_gaps=retrieval_gaps(descriptor))
            return receipt

        index_input = [graph_receipt, index_delta]
        if prepared:
            index_input.append(prepared)
        index_receipt = self._step(library, job, "INDEX", digest(index_input), save_index)
        self._stage(library, job, request, graph_receipt, index_receipt, _diff(previous, graph, redirects))
        return self.confirm(library, job, reconcile=False)

    def _apply_index_refresh(self, library, job, request, graph, old_index):
        from ontoweave_index.repository import retrieval_gaps, validate_prepared

        fingerprint = digest(request)
        base = request["base_view_revision"]
        prepared = request["prepared_index"]

        def bind_facts(q, _info):
            adopted = manifest(q, library, base)
            require(request["fact_bundle_ref"] == adopted["fact_bundle_ref"] and
                    request["target_revisions"] == {field: adopted[field] for field in TARGET_KEYS},
                    "INDEX_REFRESH_BUSINESS_BASIS_CHANGED", 409)
            validate_prepared(q, request, graph, prepared)
            return dict(fact_revision=adopted["fact_revision"], source_view_revision=base,
                        source_fact_bundle_ref=adopted["fact_bundle_ref"], reused_confirmed_business=True)

        fact = self._step(library, job, "FACT", fingerprint, bind_facts)

        def bind_graph(q, _info):
            adopted = manifest(q, library, base)
            return dict(revision=adopted["graph_revision"], snapshot_sha=_row_digest(graph), affected=[])

        graph_receipt = self._step(library, job, "GRAPH", digest([fingerprint, fact]), bind_graph)

        def bind_index(q, _info):
            descriptor = validate_prepared(q, request, graph, prepared)
            return dict(revision=descriptor["index_revision"], snapshot_sha=_row_digest(old_index),
                        affected=[], components={**INDEX_COMPONENTS, **descriptor["components"]},
                        index_descriptor_ref=descriptor["index_descriptor_ref"],
                        index_descriptor_sha256=prepared["descriptor_sha256"],
                        retrieval_gaps=retrieval_gaps(descriptor))

        index = self._step(library, job, "INDEX", digest([graph_receipt, prepared]), bind_index)
        self._stage(library, job, request, graph_receipt, index, _diff(graph, graph, []))
        return self.confirm(library, job, reconcile=False)

    def _stage(self, library, job, request, graph, index, diff):
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            info = get_job(q, library, job)
            if info["target_view_revision"]:
                return
            require(info["status"] == "RUNNING", "JOB_NOT_RESUMABLE")
            base = info["base_view_revision"]
            assert_base(state, base)
            sequence = state["activation_seq"] + 1
            view = ref("view", library, job, graph["revision"], index["revision"])
            change = ref("change", library, view)
            body = dict(library_ref=library, view_revision=view, parent_view_revision=base,
                        **{key: request["target_revisions"][key] for key in TARGET_KEYS},
                        source_manifest_ref=request["source_manifest_ref"], fact_bundle_ref=request["fact_bundle_ref"],
                        graph_revision=graph["revision"], index_revision=index["revision"], activation_seq=sequence,
                        coverage=request["coverage"], gaps=request["gaps"], index_components=index["components"])
            if request["trigger"]["kind"] == "INDEX_REFRESH":
                body["index_refresh"] = True
            if index.get("index_descriptor_ref"):
                gaps = [item for item in body["gaps"] if item.get("domain") != "RETRIEVAL_INDEX"]
                gaps.extend(index["retrieval_gaps"])
                body.update(index_descriptor_ref=index["index_descriptor_ref"],
                            index_descriptor_sha256=index["index_descriptor_sha256"],
                            gaps=gaps, coverage="PARTIAL" if gaps else "FULL")
            q("""INSERT INTO publication_v1.manifests(library_ref,view_revision,parent_view_revision,activation_seq,
                 job_ref,body,body_sha) VALUES(%s,%s,%s,%s,%s,%s,%s)""",
              [library, view, base, sequence, job, Jsonb(body), digest(body)])
            for kinds, receipt in ((GRAPH_KINDS, graph), (INDEX_KINDS, index)):
                actual = projection(q, library, view, kinds)
                require(_row_digest(actual) == receipt["snapshot_sha"], "PROJECTION_DIGEST_MISMATCH", 503)
            changed = dict(diff, change_ref=change, scope={"at": None}, **{"from": base, "to": view})
            q("INSERT INTO publication_v1.changes VALUES(%s,%s,%s,%s)", [library, change, view, Jsonb(changed)])
            q("UPDATE publication_v1.libraries SET pending_view_revision=%s WHERE library_ref=%s", [view, library])
            q("UPDATE publication_v1.jobs SET target_view_revision=%s WHERE library_ref=%s AND job_ref=%s",
              [view, library, job])

    def confirm(self, library, job, *, reconcile=True):
        # A separate transaction observes the original activation commit before assigning a confirmation boundary.
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            info = get_job(q, library, job)
            view = info["target_view_revision"]
            if info["status"] == "SUCCEEDED":
                return manifest(q, library, view)
            require(view and state["pending_view_revision"] == view, "COMMIT_NOT_CONFIRMED", 409, job_ref=job)
            require(info["status"] in ({"RUNNING", "UNKNOWN_HOLD"} if reconcile else {"RUNNING"}),
                    "JOB_NOT_RESUMABLE")
            prepared = q("""SELECT body,body_sha FROM publication_v1.manifests
                            WHERE library_ref=%s AND view_revision=%s AND job_ref=%s""",
                         [library, view, job]).fetchone()
            body = prepared["body"]
            require(digest(body) == prepared["body_sha"] and
                    body["parent_view_revision"] == state["active_view_revision"] and
                    body["activation_seq"] == state["activation_seq"] + 1 and
                    set(steps(q, library, job)) == {"FACT", "GRAPH", "INDEX"}, "CONFIRMATION_TARGET_INVALID", 503)
            activated = q("SELECT clock_timestamp() AS boundary").fetchone()["boundary"]
            if self.activate_identity:
                self.activate_identity(q, library, body, activated)
            q("INSERT INTO publication_v1.confirmations VALUES(%s,%s,%s)", [library, view, activated])
            q("""UPDATE publication_v1.libraries SET active_view_revision=%s,pending_view_revision=NULL,
                 activation_seq=%s WHERE library_ref=%s""", [view, body["activation_seq"], library])
            q("UPDATE publication_v1.jobs SET status='SUCCEEDED',failure=NULL WHERE library_ref=%s AND job_ref=%s",
              [library, job])
            row = q("""UPDATE publication_v1.decisions SET status='APPLIED'
                       WHERE library_ref=%s AND job_ref=%s RETURNING supersedes""", [library, job]).fetchone()
            if row and row["supersedes"]:
                q("UPDATE publication_v1.decisions SET status='SUPERSEDED' WHERE library_ref=%s AND decision_ref=%s",
                  [library, row["supersedes"]])
            change = ref("change", library, view)
            event(q, library, "publication.published",
                  dict(activation_seq=body["activation_seq"], coverage=body["coverage"], gaps=body["gaps"],
                       change_ref=change), run=info["request"].get("run_ref"), job=job, view=view, change=change)
        return dict(body, library_ref=library, activated_at=activated.isoformat())

    def _fail(self, library, job, status, failure):
        try:
            with self.store.transaction() as (q, _):
                state = head(q, library, lock=True)
                info = get_job(q, library, job)
                if info["status"] in {"SUCCEEDED", "CANCELLED", "UNKNOWN_HOLD"}:
                    return
                if info["target_view_revision"]:
                    status = "UNKNOWN_HOLD"
                q("UPDATE publication_v1.jobs SET status=%s,failure=%s WHERE library_ref=%s AND job_ref=%s",
                  [status, Jsonb(failure), library, job])
                event(q, library, "publication.failed",
                      dict(job_status=status, failure=failure, active_view_revision=state["active_view_revision"]),
                      run=info["request"].get("run_ref"), job=job)
        except (OperationalError, InterfaceError, PublicationError):
            if status != "UNKNOWN_HOLD":
                raise
