"""Versioned graph and search projections with one PostgreSQL activation point."""

from collections import defaultdict
from dataclasses import dataclass

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require
from ontoweave_cq_similarity.core import digest

from .input import name_key, ref
from .matching import Groups
from .storage import bindings_at, decisions_at, is_publication_managed, library_lock, reviews_at, revision_at, source_state

RULE_RESULTS = {"SAME_ASSERTION", "COEXIST", "SUCCESSION", "CORRECTION", "CONFLICT_REVIEW",
                "OPEN_UNINTERPRETED"}


def stage_job(q, revision, decision_refs, previous, updates, occurrences, statements, review_entities=(),
              rule_context=None):
    library = revision["library_ref"]
    current = {**previous, **updates}
    mapped_changes = {
        e["entity_ref"]
        for key in updates for e in (previous.get(key), current.get(key)) if e
    }
    affected_statements = {
        statement
        for key, binding in current.items()
        if binding["entity_ref"] in mapped_changes or (previous.get(key) or {}).get("entity_ref") in mapped_changes
        for statement in occurrences[key]["statement_refs"]
    }
    for statement_ref, statement in statements.items():
        if not statement["endpoints"] and statement.get("is_new"):
            affected_statements.add(statement_ref)
    context = rule_context or {}
    fact_delta = dict(
        contract="ontoweave-identity-fact-delta/1", library_ref=library,
        decision_ref=decision_refs[-1] if decision_refs else None, decision_refs=decision_refs,
        previous_identity_revision=(revision_at(q, library, revision["parent_revision"]) or {}).get("identity_revision"),
        target_identity_revision=revision["identity_revision"],
        affected_entity_refs=sorted(mapped_changes),
        affected_statement_refs=sorted(affected_statements),
        affected_candidate_refs=sorted({statements[s]["candidate_ref"] for s in affected_statements}),
        declared_constraint_refs=context.get("declared_constraint_refs", []),
        ontology_revision=context.get("ontology_revision"),
        time_interpretation_revision=context.get("time_interpretation_revision"),
    )
    job_ref = ref("identity_job", [library, revision["identity_revision"], decision_refs])
    payload = dict(**fact_delta, job_ref=job_ref, view_revision=revision["view_revision"],
                   review_entities=sorted(set(review_entities)),
                   metrics=dict(changed_bindings=len(updates)))
    q("""INSERT INTO identity_v1.publication_jobs(job_ref,library_ref,revision,status,payload)
         VALUES(%s,%s,%s,'PENDING',%s)""", [job_ref, library, revision["revision"], Jsonb(payload)])
    return _receipt(payload, "PENDING", revision_at(q, library, revision["parent_revision"]))


def _receipt(payload, status, active, **extra):
    return dict(
        job_ref=payload["job_ref"], decision_ref=payload["decision_ref"],
        decision_refs=payload["decision_refs"], decision_status="SAVED" if payload["decision_refs"] else "NONE",
        identity_revision=payload["target_identity_revision"], view_revision=payload["view_revision"],
        active_view_revision=(active or {}).get("view_revision"),
        application_status=status, active=status == "APPLIED" and bool(active)
        and active["view_revision"] == payload["view_revision"], **extra,
    )


def _statement_projection(statement, bindings, result):
    endpoints = [{**endpoint, "entity_ref": bindings[endpoint["occurrence_ref"]]["entity_ref"]}
                 for endpoint in statement["endpoints"]]
    by_role = {e["role"]: e["entity_ref"] for e in endpoints if e["role"] != "QUALIFIER_ENTITY"}
    candidate = statement["candidate"]
    qualifiers = [{**q} for q in candidate["qualifiers"]]
    for e in endpoints:
        if e["role"] == "QUALIFIER_ENTITY":
            qualifiers[e["position"]]["entity_ref"] = e["entity_ref"]
    kind = "OPEN_ONLY"
    if candidate["structure_usable"] and by_role.get("SUBJECT"):
        kind = "RELATION" if by_role.get("OBJECT") else "ATTRIBUTE"
    return dict(**{k: v for k, v in statement.items() if k not in ("endpoints", "is_new")},
                endpoints=endpoints, subject_entity_ref=by_role.get("SUBJECT"),
                object_entity_ref=by_role.get("OBJECT"), projection_kind=kind,
                qualifiers=qualifiers, interpretation=result)


def _live_reviews(reviews, groups):
    # A refreshed evidence version for the same original pair replaces the prior queue entry.
    by_home_pair = {}
    for review in reviews:
        by_home_pair[review["left_ref"], review["right_ref"]] = review
    grouped = defaultdict(list)
    for review in by_home_pair.values():
        original = review["left_ref"], review["right_ref"]
        if not all(e in groups.representative for e in original):
            continue
        left, right = sorted(groups.representative[e] for e in original)
        blocked = groups.constraints(left, right)
        if left == right:
            continue
        if blocked:
            prior_newer = any(d["stored_revision"] >= review["stored_revision"] for d in blocked)
            positive_evidence = (review["reliable_same"] or review["direct_alias"]
                                 or (review.get("judgment") or {}).get("judgment") == "SAME")
            if prior_newer or not positive_evidence:
                continue
        if review.get("status") == "CLOSED":
            continue
        grouped[left, right].append((review, blocked))
    result = {}
    for (left, right), rows in sorted(grouped.items()):
        primary, blocked = rows[-1]
        status = primary.get("status", "PENDING")
        result[primary["review_ref"]] = dict(
            **{k: v for k, v in primary.items() if k != "status"}, status=status,
            current_left_ref=left, current_right_ref=right,
            supporting_review_refs=sorted(r["review_ref"] for r, _ in rows),
            blocking_decision_refs=[d["decision_ref"] for d in blocked],
        )
    return result


def _graph_at(q, library, revision, kind, refs=None):
    sql = """SELECT DISTINCT ON (row_ref) row_ref,payload FROM identity_v1.graph_rows
             WHERE library_ref=%s AND kind=%s AND revision<=%s"""
    args = [library, kind, revision or 0]
    if refs is not None:
        sql += " AND row_ref=ANY(%s)"
        args.append(sorted(refs))
    rows = q(sql + " ORDER BY row_ref,revision DESC", args).fetchall()
    return {r["row_ref"]: r["payload"] for r in rows if r["payload"] is not None}


def _graph_rows(q, library, revision, kind, before, after, refs):
    written = 0
    for key in sorted(refs):
        value = after.get(key)
        if before.get(key) == value:
            continue
        q("""INSERT INTO identity_v1.graph_rows(library_ref,kind,row_ref,revision,payload)
             VALUES(%s,%s,%s,%s,%s)""", [library, kind, key, revision, Jsonb(value) if value is not None else None])
        written += 1
    return written


def _node(entity, occurrence_rows, statement_refs, reviews):
    if not occurrence_rows:
        return None
    rows = sorted(occurrence_rows, key=lambda o: (o["role"] != "DECLARATION", o["occurrence_ref"]))
    names = sorted({r["name_raw"] for r in rows})
    aliases = sorted({a["name_raw"] for r in rows for a in r["alias_observations"]} - set(names))
    review_refs = reviews.get(entity, [])
    return dict(entity_ref=entity, display_name=rows[0]["name_raw"], names=names, aliases=aliases,
                occurrence_refs=[r["occurrence_ref"] for r in rows],
                statement_refs=sorted(statement_refs),
                type_observations=sorted({t["type_raw"] for r in rows for t in r["type_observations"]}),
                identity_pending=bool(review_refs) or any(r["warnings"] for r in rows),
                review_refs=sorted(review_refs))


class PGProjection:
    """Persist append-only deltas. Read historical rows through the same version selector."""

    def graph(self, q, revision, job, data):
        library, target, parent = revision["library_ref"], revision["revision"], revision["parent_revision"]
        homes, occurrences, statements, bindings, groups, reviews, interpretations = data
        old_reviews = _graph_at(q, library, parent, "REVIEW")
        new_reviews = _live_reviews(reviews, groups)
        written_reviews = _graph_rows(q, library, target, "REVIEW", old_reviews, new_reviews,
                                      old_reviews.keys() | new_reviews.keys())
        review_by_entity = defaultdict(list)
        affected = set(job["affected_entity_refs"]) | set(job["review_entities"])
        for reviews_by_ref in (old_reviews, new_reviews):
            for key, review in reviews_by_ref.items():
                endpoints = [review["current_left_ref"], review["current_right_ref"]]
                if old_reviews.get(key) != new_reviews.get(key):
                    affected.update(endpoints)
                if reviews_by_ref is new_reviews:
                    for entity in endpoints:
                        review_by_entity[entity].append(key)
        old_statements = _graph_at(q, library, parent, "STATEMENT")
        changed_statements = {s: _statement_projection(statements[s], bindings, interpretations[s])
                              for s in job["affected_statement_refs"]}
        for key, statement in changed_statements.items():
            for side in (old_statements.get(key), statement):
                if side:
                    affected.update(e["entity_ref"] for e in side["endpoints"])
        written_statements = _graph_rows(q, library, target, "STATEMENT", old_statements, changed_statements,
                                         changed_statements.keys())
        old_nodes = _graph_at(q, library, parent, "NODE", affected)
        rows_by_entity = defaultdict(list)
        statements_by_entity = defaultdict(set)
        effective_statements = {**old_statements, **changed_statements}
        for occurrence, binding in bindings.items():
            if binding["entity_ref"] in affected:
                rows_by_entity[binding["entity_ref"]].append(occurrences[occurrence])
        for s, statement in effective_statements.items():
            for e in statement["endpoints"]:
                if e["entity_ref"] in affected:
                    statements_by_entity[e["entity_ref"]].add(s)
        nodes = {e: _node(e, rows_by_entity[e], statements_by_entity[e], review_by_entity) for e in affected}
        written_nodes = _graph_rows(q, library, target, "NODE", old_nodes, nodes, affected)
        receipt = dict(status="READY", revision=ref("identity_graph", revision["view_revision"]),
                       view_revision=revision["view_revision"], written_nodes=written_nodes,
                       written_statements=written_statements, written_reviews=written_reviews,
                       affected_index_entities=sorted(affected), remaining_review_count=len(new_reviews))
        return receipt

    def index(self, q, revision, graph_receipt):
        library, target = revision["library_ref"], revision["revision"]
        entities = graph_receipt["affected_index_entities"]
        nodes = _graph_at(q, library, target, "NODE", entities)
        statement_refs = {key for node in nodes.values() for key in node["statement_refs"]}
        statements = _graph_at(q, library, target, "STATEMENT", statement_refs)
        old = _index_at(q, library, revision["parent_revision"], refs=entities)
        written = 0
        for entity in entities:
            node = nodes.get(entity)
            payload, names = None, []
            if node:
                names = sorted({name_key(n) for n in node["names"] + node["aliases"]})
                related = [dict(statement_ref=s, text=statements[s]["record"]["raw_utf8"],
                                entity_refs=sorted({e["entity_ref"] for e in statements[s]["endpoints"]}))
                           for s in node["statement_refs"]]
                payload = dict(entity_ref=entity, display_name=node["display_name"], names=node["names"],
                               aliases=node["aliases"], statements=related)
            if old.get(entity) == payload:
                continue
            q("""INSERT INTO identity_v1.index_documents(library_ref,entity_ref,revision,names,payload)
                 VALUES(%s,%s,%s,%s,%s)""", [library, entity, target, names, Jsonb(payload) if payload else None])
            written += 1
        return dict(status="READY", revision=ref("identity_index", revision["view_revision"]),
                    view_revision=revision["view_revision"], written_documents=written,
                    backends=["PG_ENTITY_NAME", "PG_ENTITY_DOCUMENT"])


def _index_at(q, library, revision, query=None, refs=None):
    if query is None:
        sql = """SELECT DISTINCT ON (entity_ref) entity_ref,payload FROM identity_v1.index_documents
                 WHERE library_ref=%s AND revision<=%s"""
        args = [library, revision or 0]
        if refs is not None:
            sql += " AND entity_ref=ANY(%s)"
            args.append(sorted(refs))
        rows = q(sql + " ORDER BY entity_ref,revision DESC", args).fetchall()
    else:
        rows = q("""SELECT d.entity_ref,d.payload FROM identity_v1.index_documents d
                    WHERE library_ref=%s AND revision<=%s AND names @> ARRAY[%s]::text[]
                      AND NOT EXISTS (
                        SELECT 1 FROM identity_v1.index_documents n
                        WHERE n.library_ref=d.library_ref AND n.entity_ref=d.entity_ref
                          AND n.revision>d.revision AND n.revision<=%s)
                    ORDER BY entity_ref""", [library, revision, name_key(query), revision]).fetchall()
    return {r["entity_ref"]: r["payload"] for r in rows if r["payload"] is not None}


@dataclass
class Ports:
    fact: object = None
    graph: object = None
    index: object = None
    impact: object = None


def _fact_results(port, delta, inputs):
    expected = {s["statement_ref"] for s in inputs}
    if port is None:
        values = {key: dict(result="OPEN_UNINTERPRETED", reason="ONTOLOGY_OR_TIME_NOT_INTERPRETED")
                  for key in expected}
    else:
        values = port(delta, inputs)
    require(set(values) == expected and all(v["result"] in RULE_RESULTS for v in values.values()),
            "IDENTITY_FACT_DISPOSITION_INVALID")
    require(all(v["result"] == "OPEN_UNINTERPRETED" or v.get("rule_ref") for v in values.values()),
            "IDENTITY_FACT_RULE_REFERENCE_MISSING")
    return values


def _locked_job(q, job_ref, *, publisher=False):
    job = q("SELECT * FROM identity_v1.publication_jobs WHERE job_ref=%s", [job_ref]).fetchone()
    require(job, "IDENTITY_JOB_UNKNOWN")
    head = library_lock(q, job["library_ref"], publisher=publisher)
    job = q("SELECT * FROM identity_v1.publication_jobs WHERE job_ref=%s FOR UPDATE", [job_ref]).fetchone()
    active = revision_at(q, job["library_ref"], head["active_revision"])
    revision = revision_at(q, job["library_ref"], job["revision"])
    require(job["status"] == "APPLIED" or head["pending_revision"] == job["revision"],
            "IDENTITY_JOB_SUPERSEDED")
    return job, head, active, revision


def _disposition_inputs(q, library, revision, job, statements, bindings):
    previous = bindings_at(q, library, revision["parent_revision"])
    return [
        dict(statement_ref=key, candidate=statements[key]["candidate"], record=statements[key]["record"],
             origin=statements[key]["origin"], source_refs=statements[key]["source_refs"],
             endpoints=[{**e, "previous_entity_ref": (previous.get(e["occurrence_ref"]) or {}).get("entity_ref"),
                         "entity_ref": bindings[e["occurrence_ref"]]["entity_ref"]}
                        for e in statements[key]["endpoints"]])
        for key in job["affected_statement_refs"]
    ]


def _persist_step(q, job_ref, payload):
    q("UPDATE identity_v1.publication_jobs SET status='PENDING',payload=%s WHERE job_ref=%s",
      [Jsonb(payload), job_ref])


def _step(store, job_ref, key, execute, *, publisher=False):
    with store.transaction() as (q, _):
        job, _, active, revision = _locked_job(q, job_ref, publisher=publisher)
        payload = job["payload"]
        if job["status"] == "APPLIED" or key in payload:
            return None
        q("SAVEPOINT identity_projection_step")
        try:
            result = execute(q, revision, payload)
            q("RELEASE SAVEPOINT identity_projection_step")
        except Exception as exc:
            q("ROLLBACK TO SAVEPOINT identity_projection_step")
            q("RELEASE SAVEPOINT identity_projection_step")
            failure = dict(stage=key, code=getattr(exc, "code", None) or type(exc).__name__)
            q("UPDATE identity_v1.publication_jobs SET status='FAILED',payload=%s WHERE job_ref=%s",
              [Jsonb({**payload, "failure": failure}), job_ref])
            return _receipt(payload, "FAILED", active, failure=failure)
        payload.pop("failure", None)
        _persist_step(q, job_ref, {**payload, key: result})
    return None


def _projection_steps(ports):
    ports = ports or Ports()
    pg = PGProjection()

    def fact_step(q, revision, job):
        library, target = revision["library_ref"], revision["revision"]
        _, _, statements = source_state(q, library, target)
        bindings = bindings_at(q, library, target)
        delta = {k: v for k, v in job.items() if k in (
            "contract", "library_ref", "decision_ref", "decision_refs", "previous_identity_revision",
            "target_identity_revision", "affected_entity_refs", "affected_statement_refs",
            "affected_candidate_refs", "declared_constraint_refs", "ontology_revision",
            "time_interpretation_revision")}
        inputs = _disposition_inputs(q, library, revision, job, statements, bindings)
        return dict(input_sha256=digest(inputs), result=_fact_results(ports.fact, delta, inputs), delta=delta)

    def graph_step(q, revision, job):
        library, target = revision["library_ref"], revision["revision"]
        homes, occurrences, statements = source_state(q, library, target)
        bindings = bindings_at(q, library, target)
        groups = Groups(set(homes.values()), decisions_at(q, library, target))
        data = (homes, occurrences, statements, bindings, groups, reviews_at(q, library, target),
                job["fact"]["result"])
        result = (ports.graph or pg.graph)(q, revision, job, data)
        require(result["status"] == "READY" and result["view_revision"] == revision["view_revision"],
                "IDENTITY_GRAPH_NOT_READY")
        affected = set(result["affected_index_entities"])
        require(set(job["affected_entity_refs"]) <= affected, "IDENTITY_GRAPH_AFFECTED_SCOPE_INVALID")
        affected_bindings = {b["entity_ref"] for b in bindings.values() if b["entity_ref"] in affected}
        actual_nodes = _graph_at(q, library, target, "NODE", affected)
        require(set(actual_nodes) == affected_bindings, "IDENTITY_GRAPH_AFFECTED_NODE_COVERAGE")
        actual_facts = _graph_at(q, library, target, "STATEMENT", job["affected_statement_refs"])
        require(all(actual_facts.get(key) == _statement_projection(statements[key], bindings, job["fact"]["result"][key])
                    for key in job["affected_statement_refs"]), "IDENTITY_GRAPH_AFFECTED_STATEMENT_COVERAGE")
        return result

    def index_step(q, revision, job):
        result = (ports.index or pg.index)(q, revision, job["graph"])
        require(result["status"] == "READY" and result["view_revision"] == revision["view_revision"],
                "IDENTITY_INDEX_NOT_READY")
        library, target = revision["library_ref"], revision["revision"]
        affected = job["graph"]["affected_index_entities"]
        require(set(_graph_at(q, library, target, "NODE", affected)) == set(_index_at(q, library, target, refs=affected)),
                "IDENTITY_INDEX_AFFECTED_COVERAGE")
        return result

    return (("fact", fact_step), ("graph", graph_step), ("index", index_step))


def _prepare_steps(store, job_ref, ports=None, *, publisher=False):
    for key, execute in _projection_steps(ports):
        failed = _step(store, job_ref, key, execute, publisher=publisher)
        if failed:
            return failed
    return None


def _activate_prepared(q, job, head, revision, activated_at):
    payload = job["payload"]
    material = dict(graph_revision=payload["graph"]["revision"], index_revision=payload["index"]["revision"],
                    remaining_review_count=payload["graph"]["remaining_review_count"],
                    delta=payload["fact"]["delta"], fact=payload["fact"], graph=payload["graph"],
                    index=payload["index"])
    if job["status"] != "APPLIED":
        require(head["active_revision"] == revision["parent_revision"], "IDENTITY_ACTIVATION_BASE_CHANGED")
        q("""INSERT INTO identity_v1.active_views(library_ref,revision,graph_revision,index_revision,payload)
             VALUES(%s,%s,%s,%s,%s)""",
          [job["library_ref"], job["revision"], material["graph_revision"], material["index_revision"], Jsonb(material)])
        q("""UPDATE identity_v1.revisions SET activated_at=%s
             WHERE library_ref=%s AND revision=%s""", [activated_at, job["library_ref"], job["revision"]])
        q("""UPDATE identity_v1.libraries SET active_revision=%s,pending_revision=NULL WHERE library_ref=%s""",
          [job["revision"], job["library_ref"]])
        q("UPDATE identity_v1.publication_jobs SET status='APPLIED' WHERE job_ref=%s", [job["job_ref"]])
    return _receipt(payload, "APPLIED", revision, **material)


def apply_identity_change(store, job_ref, ports=None):
    failed = _prepare_steps(store, job_ref, ports)
    if failed:
        return failed
    with store.transaction() as (q, _):
        job, head, _, revision = _locked_job(q, job_ref)
        boundary = q("SELECT transaction_timestamp() AS boundary").fetchone()["boundary"]
        return _activate_prepared(q, job, head, revision, boundary)


def prepare_for_publisher(store, job_ref, dispositions):
    return _prepare_steps(store, job_ref, Ports(fact=lambda _delta, inputs: {
        row["statement_ref"]: dispositions[row["statement_ref"]] for row in inputs
    }), publisher=True)


def stage_compound_identity(q, change, dispositions):
    """Consume a sealed plan and prepare the legacy mirror inside the FACT transaction."""
    from .compound_decisions import verify_change_bundle
    from .storage import create_revision, insert_decision, update_bindings

    verify_change_bundle(change)
    library = change["library_ref"]
    state = library_lock(q, library, publisher=True)
    parent = revision_at(q, library, state["active_revision"])
    require(parent and parent["identity_revision"] == change["base_identity_revision"]
            and parent["revision"] == change["base_identity_sequence"], "IDENTITY_ACTIVATION_BASE_CHANGED")
    action = change["identity_event"]
    revision = create_revision(q, state, [action["decision_ref"]])
    require(revision["identity_revision"] == change["target_identity_revision"], "IDENTITY_TARGET_REVISION_CHANGED")
    homes, occurrences, statements = source_state(q, library, revision["revision"])
    before = bindings_at(q, library, parent["revision"])
    insert_decision(q, library, revision["revision"], action, 0)
    groups = Groups(set(homes.values()), decisions_at(q, library, revision["revision"]))
    updates = update_bindings(q, library, revision["revision"], homes, groups, before)
    require(updates == {key:item["next"] for key,item in change["binding_updates"].items()},
            "IDENTITY_TARGET_BINDINGS_CHANGED")
    staged = stage_job(q, revision, [action["decision_ref"]], before, updates, occurrences, statements,
                       review_entities=change["affected_entity_refs"])
    job_ref = staged["job_ref"]
    job = q("SELECT payload FROM identity_v1.publication_jobs WHERE job_ref=%s", [job_ref]).fetchone()["payload"]
    # An audit-only binding update can change the mirror without reinterpreting the original fact.
    previous_statements = _graph_at(q, library, parent["revision"], "STATEMENT", job["affected_statement_refs"])
    interpretations = {key:row["interpretation"] for key,row in previous_statements.items()}
    interpretations.update(dispositions)
    ports = Ports(fact=lambda _delta, inputs: {row["statement_ref"]:interpretations[row["statement_ref"]]
                                               for row in inputs})
    for key, execute in _projection_steps(ports):
        job[key] = execute(q, revision, job)
    _persist_step(q, job_ref, job)
    return {"identity_revision":revision["identity_revision"], "identity_job_ref":job_ref}


def activate_for_publisher(q, library, body, activated_at):
    selected = q("""SELECT j.job_ref FROM identity_v1.publication_jobs j
                    JOIN identity_v1.revisions r USING(library_ref,revision)
                    WHERE j.library_ref=%s AND r.identity_revision=%s""",
                 [library, body["identity_revision"]]).fetchone()
    require(selected, "IDENTITY_PUBLICATION_TARGET_UNKNOWN")
    job, state, active, revision = _locked_job(q, selected["job_ref"], publisher=True)
    if job["status"] == "APPLIED":
        require(active == revision, "IDENTITY_ACTIVATION_BASE_CHANGED")
    else:
        _activate_prepared(q, job, state, revision, activated_at)


def read_identity_view(store, library_ref, view_revision=None, query=None):
    with store.transaction(readonly=True) as (q, _):
        require(not is_publication_managed(q, library_ref), "IDENTITY_PUBLICATION_OWNER_MISMATCH")
        head = q("SELECT active_revision FROM identity_v1.libraries WHERE library_ref=%s", [library_ref]).fetchone()
        require(head and head["active_revision"], "IDENTITY_NO_ACTIVE_VIEW")
        if view_revision is None:
            revision = revision_at(q, library_ref, head["active_revision"])
        else:
            revision = q("""SELECT * FROM identity_v1.revisions
                            WHERE library_ref=%s AND view_revision=%s AND activated_at IS NOT NULL""",
                         [library_ref, view_revision]).fetchone()
        require(revision, "IDENTITY_VIEW_UNKNOWN")
        version = revision["revision"]
        row = q("SELECT * FROM identity_v1.active_views WHERE library_ref=%s AND revision=%s",
                [library_ref, version]).fetchone()
        require(row, "IDENTITY_VIEW_NOT_READY")
        statements = list(_graph_at(q, library_ref, version, "STATEMENT").values())
        nodes = _graph_at(q, library_ref, version, "NODE")
        homes, occurrences, _ = source_state(q, library_ref, version)
        index = _index_at(q, library_ref, version, query)
        status = dict(ontology="NOT_INTERPRETED", time="NOT_INTERPRETED")
        return dict(contract="ontoweave-identity-view/1", library_ref=library_ref,
                    identity_revision=revision["identity_revision"], view_revision=revision["view_revision"],
                    active=version == head["active_revision"], activated_at=revision["activated_at"].isoformat(),
                    bindings=list(bindings_at(q, library_ref, version).values()),
                    occurrences=occurrences, decisions=decisions_at(q, library_ref, version),
                    graph=dict(graph_kind="OPEN_STATEMENT_GRAPH", revision=row["graph_revision"],
                               interpretation=status, nodes=list(nodes.values()), statements=statements,
                               edges=[s for s in statements if s["projection_kind"] == "RELATION"],
                               attributes=[s for s in statements if s["projection_kind"] == "ATTRIBUTE"],
                               open_only=[s for s in statements if s["projection_kind"] == "OPEN_ONLY"]),
                    index=dict(revision=row["index_revision"], query=query, documents=list(index.values())),
                    reviews=list(_graph_at(q, library_ref, version, "REVIEW").values()),
                    publication=row["payload"])
