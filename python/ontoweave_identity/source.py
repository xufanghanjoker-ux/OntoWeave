"""Read-only authentication of extraction provenance and its frozen source archive."""

from collections import defaultdict

from ontoweave_cq.store import require, same_projection, sha
from ontoweave_extraction import RECEPTION_NAMESPACES
from ontoweave_extraction.provenance import authenticate_origins
from ontoweave_extraction.repository import Reception
from ontoweave_cq_similarity.adapter import from_archive, load_plan_materials
from ontoweave_cq_similarity.core import digest
from ontoweave_cq_similarity.repository import SimilarityRepository
from .input import recover, source_key
from .service import _store_preparation


def _verified_record(q, run_id, kind, key):
    row = q("""SELECT payload,payload_sha FROM front_half.records
               WHERE run_id=%s AND kind=%s AND key=%s""", [run_id, kind, key]).fetchone()
    require(row and digest(row["payload"]) == row["payload_sha"], "IDENTITY_SOURCE_RECORD_UNAUTHENTICATED")
    return row["payload"]


def _authenticate_reception_rows(receiver, run):
    items = {i["item_ref"]: (receipt["response_ref"], receipt["policy"], i)
             for receipt in run["receipts"] for i in receipt["items"]}
    candidates = {c["candidate_ref"]: c for c in run["candidates"]}
    with receiver.transaction(readonly=True) as (q, _):
        rows = q("""SELECT * FROM extraction_v2.items
                    WHERE item_ref=ANY(%s)""", [list(items)]).fetchall()
        require(len(rows) == len(items), "IDENTITY_SOURCE_ITEM_MISSING")
        for row in rows:
            response_ref, policy, payload = items[row["item_ref"]]
            require(row["policy"] == policy and row["response_ref"] == response_ref
                    and row["candidate_ref"] == payload.get("candidate_ref")
                    and row["byte_start"] == payload["record"]["start"]
                    and row["byte_end"] == payload["record"]["end"]
                    and same_projection(row["payload"], payload), "IDENTITY_SOURCE_ITEM_CHANGED")
        source_rows = q("""SELECT candidate_ref,source_key,payload
                           FROM extraction_v2.candidate_sources WHERE candidate_ref=ANY(%s)""",
                        [list(candidates)]).fetchall()
    sources = defaultdict(dict)
    for row in source_rows:
        require(row["source_key"] == digest(row["payload"]), "IDENTITY_CANDIDATE_SOURCE_CHANGED")
        sources[row["candidate_ref"]][row["source_key"]] = row["payload"]
    for key, candidate in candidates.items():
        expected = {digest(s): s for s in candidate["payload"]["source_scope"]}
        require(same_projection(sources[key], expected), "IDENTITY_CANDIDATE_SCOPE_CHANGED")


def authenticate_source(store, request, source, upstream_reader):
    require(source["namespace"] in RECEPTION_NAMESPACES, "IDENTITY_SOURCE_NAMESPACE_INVALID")
    started = Reception(store, RECEPTION_NAMESPACES[source["namespace"]])
    run = started.read_run(source["run_id"])
    run.setdefault("namespace", started.schema)
    run.setdefault("reception_policy", started.policy)
    plan = run["plan"]
    upstream = upstream_reader(store, plan)
    workspace = request["library_ref"]
    snapshot = upstream["snapshot"]
    require(workspace == snapshot["library_id"] == upstream["head"]["workspace"],
            "IDENTITY_SOURCE_WORKSPACE_MISMATCH")
    require(upstream["head"]["archive_id"] == plan["archive_id"]
            and upstream["similarity"]["plan_ref"] == plan["similarity_plan_ref"]
            and snapshot["snapshot_id"] == plan["snapshot_ref"], "IDENTITY_SOURCE_ARCHIVE_MISMATCH")
    materials = upstream["group_materials"]
    unit_registry = materials["units"]
    groups = {g["group_ref"]: g for g in materials["groups"]}
    all_cqs = {q["cq_ref"]: q["question"] for q in upstream["materials"]}
    task_manifests = {t["task_ref"]: t for t in plan["tasks"]}
    require(set(task_manifests) == {t["task_ref"] for t in run["tasks"]}, "IDENTITY_SOURCE_TASK_COVERAGE")
    source_units, source_tasks = {}, []
    documents = {d["doc_id"]: d["title"] for d in snapshot["documents"]}
    for task in run["tasks"]:
        manifest = task["manifest"]
        require(task["run_id"] == run["run_id"] and same_projection(manifest, task_manifests[task["task_ref"]]),
                "IDENTITY_SOURCE_TASK_CHANGED")
        unit_keys = {key for group in manifest["group_refs"] for key in groups[group]["unit_keys"]}
        cq_refs = {cq for group in manifest["group_refs"] for cq in groups[group]["cq_refs"]}
        got_cqs = {q["cq_ref"]: q["question"] for q in manifest["questions"]}
        require(got_cqs == {cq: all_cqs[cq] for cq in cq_refs}, "IDENTITY_ORIGINAL_CQ_CHANGED")
        for unit in manifest["sources"].values():
            unit_key = digest(dict(zip(("doc_ref", "revision", "chunk_ref", "unit_ref"), source_key(unit))))
            require(unit_key in unit_keys and unit["text_sha256"] == sha(unit["text"])
                    and unit["snapshot_ref"] == snapshot["snapshot_id"]
                    and same_projection(unit_registry[unit_key],
                                        {k: v for k, v in unit.items() if k not in ("text_sha256", "snapshot_ref")}),
                    "IDENTITY_ORIGINAL_UNIT_CHANGED")
            source_units[unit_key] = dict(unit_ref=unit["unit_ref"], doc_ref=unit["doc_ref"],
                                          revision=unit["revision"], chunk_ref=unit["chunk_ref"],
                                          document_title=documents[unit["doc_ref"]], text_sha256=unit["text_sha256"])
        source_tasks.append(dict(task_ref=task["task_ref"], status=task["status"], frozen=task["frozen"],
                                 manifest_sha256=digest(manifest), cq_refs=sorted(cq_refs)))
    _authenticate_reception_rows(started, run)
    origins = authenticate_origins(store, run, started.policy)
    occurrences, statements, gaps = recover(run, origins)
    gaps.extend(dict(code="SOURCE_TASK_GAP", task_ref=t["task_ref"], status=t["status"])
                for t in run["tasks"] if t["status"] not in ("COMPLETED", "NO_CANDIDATES"))
    gaps.extend(dict(code="SOURCE_PLAN_GAP", detail=gap) for gap in plan.get("gaps", []))
    manifest = dict(
        namespace=source["namespace"], run_id=source["run_id"], upstream_run_id=plan["upstream_run_id"],
        extraction_plan_sha256=digest(plan), archive_id=plan["archive_id"], snapshot_ref=plan["snapshot_ref"],
        similarity_plan_ref=plan["similarity_plan_ref"], library_ref=workspace,
        execution_status=run["execution_status"], content_counts=run["content_counts"],
        content_warnings=run["content_warnings"], candidates=len(run["candidates"]),
        statement_count=len(statements), sources=list(source_units.values()), tasks=source_tasks,
        responses=[dict(response_ref=r["response_ref"], task_ref=r["task_ref"], sha256=r["sha256"],
                        producer_run_id=r["identity"].get("producer_run_id", run["run_id"]),
                        late=r["late"], delivery_status=r["delivery"]["outcome"])
                   for r in run["responses"]],
    )
    return occurrences, statements, manifest, gaps


def prepare_from_reader(store, request, upstream_reader):
    require(request["contract"] == "ontoweave-identity-input/1" and request["library_ref"]
            and (request["source_runs"] or
                 (request.get("product_source_scope") and not request["product_source_scope"]["documents"]
                  and request.get("base_identity_revision"))), "IDENTITY_PREPARE_INPUT_INVALID")
    occurrences, statements, manifests, gaps = {}, {}, [], []
    seen = set()
    for source in request["source_runs"]:
        key = source["namespace"], source["run_id"]
        require(key not in seen, "IDENTITY_DUPLICATE_SOURCE_RUN")
        seen.add(key)
        new_occurrences, new_statements, manifest, new_gaps = authenticate_source(store, request, source, upstream_reader)
        for occurrence, payload in new_occurrences.items():
            require(occurrence not in occurrences or occurrences[occurrence] == payload,
                    "IDENTITY_SOURCE_OCCURRENCE_COLLISION")
        for statement, payload in new_statements.items():
            require(statement not in statements or statements[statement] == payload,
                    "IDENTITY_SOURCE_STATEMENT_COLLISION")
        occurrences.update(new_occurrences)
        statements.update(new_statements)
        manifests.append(manifest)
        gaps.extend(new_gaps)
    return _store_preparation(store, request, occurrences, statements, manifests, gaps)


def read_saved_upstream(store, extraction_plan):
    """Authenticate saved archive and grouping references without reading CQ vectors."""
    run_id = extraction_plan["upstream_run_id"]
    with store.transaction(readonly=True) as (q, _):
        head = _verified_record(q, run_id, "front_half", run_id)
        saved = _verified_record(q, run_id, "similarity", run_id)
    require((head["status"] == "COMPLETED" or head["status"] == "PARTIAL" and head.get("cq_archive_status") == "PARTIAL") and head["run_id"] == run_id
            and head["archive_id"] == extraction_plan["archive_id"]
            and head["plan_ref"] == saved["plan_ref"] == extraction_plan["similarity_plan_ref"],
            "IDENTITY_UPSTREAM_HISTORICAL_BINDING_MISMATCH")
    archive = store.read_archive(head["archive_id"])
    view = archive["view"]
    if head.get("cq_archive_status") == "PARTIAL":
        chunked = view["result"]["chunked"]
        require(chunked["status"] == "PARTIAL" and same_projection(chunked["execution_gaps"], head["cq_execution_gaps"])
                and all(dict(code="UPSTREAM_CQ_WINDOW_GAP", **g) in extraction_plan.get("gaps", [])
                        for g in chunked["execution_gaps"]), "IDENTITY_UPSTREAM_CQ_GAP_MISMATCH")
    require(view["run_id"] == run_id and view["snapshot"]["library_id"] == head["workspace"],
            "IDENTITY_UPSTREAM_WORKSPACE_MISMATCH")
    plan = SimilarityRepository(store).read_plan(saved["plan_ref"])
    data = saved["input"]
    require(plan["plan_ref"] == saved["plan_ref"]
            and "plan_" + digest({k: v for k, v in plan.items() if k != "plan_ref"}) == plan["plan_ref"]
            and plan["input_sha256"] == digest(data)
            and same_projection(data, from_archive(archive, head["workspace"], data["embedding_space"])),
            "IDENTITY_UPSTREAM_CQ_PLAN_MISMATCH")
    return dict(head=head, snapshot=view["snapshot"], similarity=plan,
                materials=view["merge"]["cq_input"]["items"],
                group_materials=load_plan_materials(view, data, plan["groups"]))


def prepare_identity(store, request, *, upstream_reader=read_saved_upstream):
    return prepare_from_reader(store, request, upstream_reader)
