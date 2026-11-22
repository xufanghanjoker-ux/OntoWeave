"""Composition for one new upload. Business receivers and publication retain their own ledgers."""

import asyncio
from contextlib import contextmanager
from hashlib import shake_256
from time import time
from threading import Event, Lock, Thread
import sys
from types import SimpleNamespace

from psycopg import InterfaceError, OperationalError

from ontoweave_cq5000.dispatch import NativeCodexPort
from ontoweave_cq5000.pipeline import CQPipeline
from ontoweave_cq5000.run import CQRun, KIND as CQ_RUN_KIND
from ontoweave_cq_similarity.adapter import from_archive
from ontoweave_cq_similarity.core import normalize
from ontoweave_cq_similarity.embedding import public_space
from ontoweave_cq_similarity.repository import SimilarityRepository
from ontoweave_extraction import V3_POLICY_VERSION
from ontoweave_extraction.pipeline import execute as extract
from ontoweave_extraction.repository import Reception
from ontoweave_front_half.baselines import verify_baseline
from ontoweave_front_half.native import NativeTransport
from ontoweave_front_half.parse import chunk, parse_files, write
from ontoweave_front_half.pipeline import Stages, archive_input, similarity, utc
from ontoweave_front_half.records import PGRecords
from ontoweave_identity.native import NativeRuntime as IdentityRuntime
from ontoweave_identity.publication import prepare_for_publisher
from ontoweave_identity.service import prepare_first_publication, prepare_product_successor
from ontoweave_identity.source import prepare_identity
from ontoweave_ontology.repository import OntologyRepository
from ontoweave_ontology.service import align
from ontoweave_publication.integration import prepare_initial_bundle, prepare_publication, routing_request
from ontoweave_ontology.source import load_identity
from ontoweave_publication.store import head, ref, require

from .builds import _no_usage, _unknown_usage


class BuildStop(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def _reason(error):
    if getattr(error, "code", None):
        return error.code
    if isinstance(error, ValueError) and str(error).isupper() and len(str(error)) < 160:
        return str(error)
    return type(error).__name__


def _failure(error):
    code = _reason(error)
    unknown = (isinstance(error, (InterfaceError, OperationalError))
               or code in {"COMMIT_UNKNOWN", "EMBEDDING_OUTCOME_UNKNOWN", "PRODUCT_WORKER_FENCED"})
    return (error.status if isinstance(error, BuildStop) else "UNKNOWN_HOLD" if unknown else "FAILED"), code


def _gaps(items):
    return [{**item, "reason_code": item.get("reason_code") or item.get("code") or item.get("status") or "INCOMPLETE"}
            for item in items if not item.get("nonblocking")]


def _usage(real=0, simulated=0, embedding=0, reports=()):
    return dict(generation_requests=real, simulated_generation_requests=simulated,
                embedding_requests=embedding, provider_usage=list(reports))


class Progress:
    def __init__(self, builds, library, run, guard):
        self.builds = builds
        self.library = library
        self.run = run
        self.current = "PARSING"
        self.guard = guard

    def record(self, stage, status, **fields):
        self.current = stage
        self.builds.stage(self.library, self.run, stage, status, **fields)

    def report(self, stage, counts):
        try:
            self.builds.progress(self.library, self.run, stage, counts)
        except Exception as error:
            # A telemetry failure does not change business settlement or provider request status.
            print("Product build progress:", stage, _reason(error), file=sys.stderr)

    @contextmanager
    def observe(self, stage, sample):
        stop = Event()

        def poll():
            while not stop.wait(.4):
                try:
                    counts = sample()
                    if counts:
                        self.report(stage, counts)
                except Exception as error:
                    print("Product progress sample:", stage, _reason(error), file=sys.stderr)

        watcher = Thread(target=poll, name="product-build-progress", daemon=True)
        watcher.start()
        try:
            yield
        finally:
            stop.set()
            watcher.join()

    @contextmanager
    def phase(self, stage, counts=None):
        self.guard()
        self.record(stage, "RUNNING", counts=counts)
        row = dict(counts=counts or {}, usage=_no_usage(), artifacts=[], gaps=[])
        yield row
        self.guard()
        self.record(stage, "PARTIAL" if row["gaps"] else "COMPLETED", **row)

    def stop(self, error):
        status, code = _failure(error)
        details = self.builds.read(self.library, self.run)
        previous = next((item for item in details["stages"] if item["stage"] == self.current), {})
        usage = _unknown_usage() if code == "PRODUCT_WORKER_FENCED" else previous.get("usage")
        self.record(self.current, status, counts=previous.get("counts"), usage=usage,
                    artifacts=previous.get("artifacts", []), gaps=[*previous.get("gaps", []), {"reason_code": code}],
                    execution_status=status)


class BatchProgress:
    def __init__(self, progress, stage):
        self.progress, self.stage = progress, stage
        self.lock = Lock()
        self.started = self.settled = 0

    def update(self, *, settled=False):
        with self.lock:
            self.started += int(not settled)
            self.settled += int(settled)
            self.progress.report(self.stage, dict(started_batches=self.started, settled_batches=self.settled))


class ObservedRuntime:
    def __init__(self, runtime, progress, stage):
        self.base = runtime
        self.telemetry = BatchProgress(progress, stage)

    def __getattr__(self, name):
        return getattr(self.base, name)

    def invoke(self, store, batch, halted):
        if halted.is_set():
            return self.base.invoke(store, batch, halted)
        self.telemetry.update()
        try:
            return self.base.invoke(store, batch, halted)
        finally:
            self.telemetry.update(settled=True)


def _extraction_counts(store, run):
    with store.transaction(readonly=True) as (q, _):
        row = q("""SELECT count(*) AS total,
                    count(*) FILTER (WHERE frozen) AS processed
                   FROM extraction_v3.tasks WHERE run_id=%s""", [run]).fetchone()
        return dict(row, unit_label="个任务") if row["total"] else {}


def _index_counts(store, library):
    with store.transaction(readonly=True) as (q, _):
        if not q("SELECT to_regclass('retrieval_v1.embedding_requests') AS table_ref").fetchone()["table_ref"]:
            return {}
        row = q("""SELECT count(*) AS started_batches,
                   count(*) FILTER (WHERE status IN ('RETURNED','FAILED','UNKNOWN')) AS settled_batches
                   FROM retrieval_v1.embedding_requests WHERE library_ref=%s""", [library]).fetchone()
        return row if row["started_batches"] else {}

def _simulate_turns(section, index, default):
    return section.get("by_index", {}).get(str(index), section.get("default", default))


class ProductCQRun(CQRun):
    def reserve(self, *, agent_scope, request_bytes=0):
        with self.repo.transaction():
            self.repo.store.product_dispatch_guard(self.repo.local.q)
            return super().reserve(agent_scope=agent_scope, request_bytes=request_bytes)


class ProductFrontHalfRecords(PGRecords):
    def put_record(self, kind, key, value):
        if kind == "embedding_request" and value["status"] == "STARTED":
            with self.transaction():
                self.store.product_dispatch_guard(self.local.q)
                return super().put_record(kind, key, value)
        return super().put_record(kind, key, value)


def _seed_simulated_embeddings(store, archive, config):
    repository = SimilarityRepository(store)
    space = public_space(config)
    data = from_archive(archive, archive["view"]["snapshot"]["library_id"], space)
    vectors = {}
    for item in data["items"]:
        raw = shake_256(normalize(item["question"]).encode()).digest(space["dimensions"])
        vectors[item["cq_ref"]] = [(v - 127.5) / 128 for v in raw]
    repository.save_vectors(data, vectors, dict(origin="NATIVE_SIM", actual_requests=0))
    return len(vectors)


def _front_half(store, settings, progress, inputs, output, public, credential, mode, scenario, document_ids):
    output.mkdir(mode=0o700)
    library, run = progress.library, progress.run
    repo = ProductFrontHalfRecords(store, run)
    repo.migrate()
    head_row = dict(run_id=run, mode=mode, workspace=library, status="RUNNING", started_at=utc(),
                    upstream_pins=verify_baseline())
    repo.put_record("front_half", run, head_row)
    stages = Stages(repo)
    completed = 0

    @contextmanager
    def parsing_stage(name, counts):
        nonlocal completed
        with stages(name, counts) as row:
            yield row
        completed += 1
        progress.report("PARSING", dict(processed=completed, total=len(inputs), unit_label="份资料"))

    with progress.phase("PARSING", {"total": len(inputs), "unit_label": "份资料"}) as phase:
        source, sources, artifacts = parse_files(
            inputs, library, run, output, settings.parser, repo, parsing_stage, document_ids=document_ids)
        write(output / "snapshot.json", source)
        phase.update(counts=dict(documents=len(source["documents"]), processed=len(source["documents"]),
                                 total=len(inputs), unit_label="份资料"), artifacts=[source["snapshot_id"]])

    with progress.phase("CHUNKING") as phase, stages("structure_chunking") as measured:
        plan = chunk(source, sources, output, settings.parser)
        repo.put_record("source_plan", run, plan)
        write(output / "plan.json", plan)
        counts = dict(blocks=len(plan["windows"]), processed=len(plan["windows"]), max_tokens=5000)
        measured.update(output_counts=counts, gaps=plan["gaps"])
        phase.update(counts=counts, artifacts=[plan["plan_ref"]], gaps=_gaps(plan["gaps"]))

    cq_run = ProductCQRun(repo, run, dict(execution_policy="PROGRESS_GOVERNED_V1",
                                   cq_chunk_policy={"concurrency": settings.concurrency}, snapshot_id=source["snapshot_id"]))
    transport = NativeTransport(repo, cq_run, public, credential)
    windows = {row["chunk_ref"]: index for index, row in enumerate(plan["windows"])}

    telemetry = BatchProgress(progress, "BLOCK_CQ")

    async def invoke(request):
        if mode == "NATIVE_SIM":
            default = [{"tool_calls": [{"name": "lightog_save_cq_list", "arguments": '{"items":[]}'}]}]
            turns = _simulate_turns(scenario.get("cq", {}), windows[request.agent_scope], default)
            request = SimpleNamespace(**vars(request), mode=mode, simulation=turns)
        telemetry.update()
        try:
            return await transport.invoke(request)
        finally:
            telemetry.update(settled=True)

    pipe = CQPipeline(repo=repo, source=source, plan=plan, run=cq_run, dispatcher=NativeCodexPort(invoke),
                      library_id=library, run_id=run, concurrency=settings.concurrency,
                      runtime_directory=output / "native")
    with progress.phase("BLOCK_CQ", {"total": len(windows), "unit_label": "个分块"}) as phase, stages("block_cq") as measured:
        try:
            result = asyncio.run(pipe.execute())
        except Exception as error:
            state = cq_run.state()
            attempts = state["attempts"]
            usage = _usage(len(attempts) if mode == "REAL" else 0, len(attempts) if mode == "NATIVE_SIM" else 0,
                           reports=[row.get("usage") for row in attempts])
            progress.record("BLOCK_CQ", "RUNNING", counts=phase["counts"], usage=usage)
            if state["status"] == "UNKNOWN_HOLD":
                raise BuildStop("UNKNOWN_HOLD", _reason(error)) from error
            raise
        finally:
            transport.close()
            write(output / "cq-rpc-timings.json", transport.timings)
        state, ledger = pipe.snapshot(), cq_run.state()
        attempts = ledger["attempts"]
        usage = _usage(len(attempts) if mode == "REAL" else 0, len(attempts) if mode == "NATIVE_SIM" else 0,
                       reports=[row.get("usage") for row in attempts])
        gaps = _gaps(state["execution_gaps"])
        counts = dict(cqs=len(result["cq_input"]["items"]), total=len(windows),
                      processed=state["summary"]["processed_work_windows"], unit_label="个分块")
        measured.update(gaps=gaps, output_counts=counts, **usage)
        archive_bundle = archive_input(run, source, plan, dict(execution_mode=mode, chunked=state), artifacts)
        store.save_archive(archive_bundle)
        head_row["archive_id"] = archive_bundle["archive_id"]
        partial = state["status"] == "PARTIAL"
        if partial:
            head_row.update(cq_archive_status="PARTIAL", cq_execution_gaps=state["execution_gaps"],
                            new_dispatch_stopped=True, dispatch_status=ledger["status"])
        repo.put_record("front_half", run, head_row)
        phase.update(counts=counts, artifacts=[head_row["archive_id"]], usage=usage, gaps=gaps)

    if ledger["status"] == "UNKNOWN_HOLD":
        head_row.update(status="UNKNOWN_HOLD", ended_at=utc())
        repo.put_record("front_half", run, head_row)
        raise BuildStop("UNKNOWN_HOLD", "CQ_DISPATCH_OUTCOME_UNKNOWN")

    archive = store.read_archive(head_row["archive_id"])
    with progress.phase("CQ_SIMILARITY") as phase:
        count = _seed_simulated_embeddings(store, archive, public["models"]["embedding"]) if mode == "NATIVE_SIM" and not partial else 0
        try:
            result = similarity(store, repo, archive, public["models"]["embedding"], credential,
                                output, stages, mode == "REAL" and not partial)
        except Exception as error:
            receipts = [row["payload"] for row in repo.list_rows() if row["kind"] == "embedding_request"]
            progress.record("CQ_SIMILARITY", "RUNNING",
                            usage=_usage(embedding=len(receipts), reports=[row.get("usage") for row in receipts]))
            if any(row["status"] in {"STARTED", "UNKNOWN"} for row in receipts):
                raise BuildStop("UNKNOWN_HOLD", "EMBEDDING_OUTCOME_UNKNOWN") from error
            if partial and str(error) == "REPLAY_CACHE_MISS_NO_EXTERNAL_CALL":
                head_row.update(status="PARTIAL", ended_at=utc(), similarity_gap={"code": str(error)})
                repo.put_record("front_half", run, head_row)
                raise BuildStop("PARTIAL", "CQ_PARTIAL_WITHOUT_SETTLED_VECTORS") from error
            raise
        embedding_row = next(row for row in stages.rows if row["stage"] == "embedding")
        phase.update(counts={key: result[key] for key in ("cqs", "groups", "pairs", "cache_hits")},
                     usage={**_usage(embedding=result["embedding_requests"], reports=embedding_row["usage"]),
                            "simulated_embedding_items": count}, artifacts=[result["plan_ref"]])
        head_row.update(result, status="PARTIAL" if partial else "COMPLETED", ended_at=utc(),
                        stages=stages.rows)
        repo.put_record("front_half", run, head_row)
        if not partial:
            with repo.transaction():
                final = cq_run.state()
                final.update(status="COMPLETED", ended_at=int(time() * 1000))
                repo.put_record(CQ_RUN_KIND, run, final)
        write(output / "result.json", head_row)
    return _gaps(plan["gaps"])


def _extraction(settings, progress, output, credential, mode, scenario, public_path, upstream_gaps):
    run = progress.run
    source_ref = ref("product_extraction", run)
    simulation = scenario.get("extraction", {})

    def turns(tasks):
        default = [{"text": "无相关知识\n理由：本次模拟未配置候选。\n\n抽取结束"}]
        answers = []
        for index, task in enumerate(tasks):
            choices = simulation.get("by_source_text", {})
            matches = {
                marker for unit in task["sources"].values()
                for marker in choices if marker in unit["text"]
            }
            require(len(matches) <= 1, "PRODUCT_SIM_SOURCE_SCENARIO_AMBIGUOUS")
            answers.append(choices[next(iter(matches))] if matches else _simulate_turns(simulation, index, default))
        return answers

    with progress.phase("EXTRACTION") as phase:
        args = SimpleNamespace(command="run", mode=mode, run_id=source_ref, upstream_run_id=run,
                               pg_config=settings.pg_path, public_config=public_path, output=output / "extraction",
                               reception_policy=V3_POLICY_VERSION, concurrency=settings.concurrency, accept_partial=True)
        with progress.observe("EXTRACTION", lambda: _extraction_counts(settings.store, source_ref)):
            summary = asyncio.run(extract(args, product_credential=credential if mode == "REAL" else None,
                                          product_simulation=turns if mode == "NATIVE_SIM" else None,
                                          product_dispatch_guard=settings.assert_owned))
        usage = _usage(summary["generation_requests"], summary.get("native_simulated_requests", 0),
                       reports=summary["full_provider_usage"])
        counts = dict(tasks=summary["tasks"], candidates=summary["candidates"], **summary["content_counts"])
        status = summary["execution_status"]
        artifacts = [source_ref]
        outcome = Reception(settings.store, V3_POLICY_VERSION).read_run(source_ref)
        gaps = _gaps([
            *outcome["plan"]["gaps"],
            *[dict(reason_code="EXTRACTION_TASK_GAP", scope_ref=row["task_ref"], status=row["status"])
              for row in outcome["tasks"] if row["status"] not in ("COMPLETED", "NO_CANDIDATES")],
        ])
        if status == "PARTIAL" and not gaps:
            gaps = [{"reason_code": "EXTRACTION_PARTIAL", "scope_ref": source_ref}]
        if status in ("UNKNOWN_HOLD", "FAILED"):
            progress.record("EXTRACTION", "RUNNING", counts=counts, usage=usage, artifacts=artifacts, gaps=gaps)
            raise BuildStop(status, "EXTRACTION_NOT_SETTLED")
        phase.update(counts=counts, usage=usage, artifacts=artifacts, gaps=gaps)
    return dict(namespace="extraction_v3", run_id=source_ref), [*upstream_gaps, *gaps]


def _identity(settings, progress, source, upstream_gaps, output, public, credential, mode, scenario, adopted, scope):
    store, library = settings.store, progress.library
    with progress.phase("IDENTITY") as phase:
        request = dict(contract="ontoweave-identity-input/1", library_ref=library,
                       publication_mode="PG", source_runs=[source] if source else [])
        if adopted:
            with store.transaction(readonly=True) as (q, _):
                base = q("""SELECT view_revision FROM identity_v1.revisions
                            WHERE library_ref=%s AND identity_revision=%s""",
                         [library, adopted["identity_revision"]]).fetchone()
                require(base, "PRODUCT_SOURCE_IDENTITY_BASIS_UNAVAILABLE")
            request.update(base_identity_revision=adopted["identity_revision"], base_view_revision=base["view_revision"],
                           publication_base_view_revision=adopted["view_revision"], product_source_scope=scope)
        prepared = prepare_identity(store, request)
        if adopted:
            result = prepare_product_successor(store, prepared, settings.assert_owned)
        else:
            runtime = IdentityRuntime(public, output / "identity", mode=mode, credential=credential,
                                      concurrency=settings.concurrency, simulation=scenario.get("identity"))
            observed = ObservedRuntime(runtime, progress, "IDENTITY")
            result = prepare_first_publication(store, prepared, observed, dispatch_guard=settings.assert_owned)
        write(output / "identity-result.json", result)
        batches = [row["native"] for row in result["batches"] if row.get("native") and not row.get("reused")]
        usage = _usage(sum(row.get("generation_requests", 0) for row in batches),
                       sum(row.get("simulated_requests", 0) for row in batches),
                       reports=[report for row in batches for report in row.get("usage", [])])
        counts = dict(prepared["counts"], eligible_pairs=result["eligible_pairs"],
                      judgments=sum("judgment" in item for item in result["judgments"].values()))
        status = result["execution_status"]
        gaps = _gaps([*prepared["gaps"], *[dict(reason_code=item["code"], scope_ref=review)
                                           for review, item in result["judgments"].items() if "code" in item]])
        if status in ("FAILED", "UNKNOWN_HOLD"):
            progress.record("IDENTITY", "RUNNING", counts=counts, usage=usage, artifacts=[prepared["prepared_ref"]], gaps=gaps)
            raise BuildStop(status, "IDENTITY_NOT_SETTLED")
        phase.update(counts=counts, usage=usage, artifacts=[prepared["prepared_ref"], result["identity_revision"]], gaps=gaps)
    return prepared, result, [*upstream_gaps, *gaps]


def execute_product(settings, progress, publisher, engine):
    store, library, run = settings.store, progress.library, progress.run
    output = settings.run_root / run
    output.mkdir(mode=0o700)
    adopted, source_snapshot_ref, documents, prior = progress.builds.basis(library, run)
    base = adopted["view_revision"] if adopted else None
    files = progress.builds.sources(library, run, output)
    document_ids = [item[0] for item in documents] if all(item[0] for item in documents) else None
    require(not adopted or all(doc and revision for doc, revision in documents), "PRODUCT_SOURCE_SNAPSHOT_INVALID")
    scope = dict(source_snapshot_ref=source_snapshot_ref, documents=documents, prior_documents=prior)
    mode, ontology_runtime, public, scenario = settings.runtime(library, output)
    public_path = output / "public-config.json"
    write(public_path, public)
    credential = ontology_runtime.credential
    source = None
    upstream = []
    if files:
        upstream = _front_half(store, settings, progress, files, output / "front-half", public, credential, mode,
                               scenario, document_ids)
        source, upstream = _extraction(settings, progress, output, credential, mode, scenario, public_path, upstream)
    else:
        require(adopted, "PRODUCT_EMPTY_FIRST_SOURCE")
        for stage in ("PARSING", "CHUNKING", "BLOCK_CQ", "CQ_SIMILARITY", "EXTRACTION"):
            with progress.phase(stage, {"total": 0}) as phase:
                phase.update(counts={"total": 0, "processed": 0})
    prepared, identity, upstream = _identity(
        settings, progress, source, upstream, output, public, credential, mode, scenario, adopted, scope)
    active = load_identity(store, library, identity["identity_revision"])
    trigger = {"kind": "SOURCE_CHANGED" if adopted else "INITIAL",
               "refs": [source["run_id"] if source else source_snapshot_ref]}
    previous_statements = set()
    if adopted:
        previous_identity = load_identity(store, library, adopted["identity_revision"])
        previous_statements = set(previous_identity["statements"])
    withdrawn = previous_statements - active["statements"].keys()

    def same_basis(q):
        state = head(q, library, lock=True)
        settings.assert_owned(q)
        return state["active_view_revision"] == base and state["pending_view_revision"] is None

    ontology_request = dict(contract="ontoweave-ontology-alignment-input/1", run_ref=run, library_ref=library,
                            identity_revision=identity["identity_revision"], base_view_revision=base, trigger=trigger)
    if adopted:
        ontology_base = adopted["ontology_revision"]
        assignments = OntologyRepository(store).snapshot(library, ontology_base)["assignments"]
        ontology_request.update(ontology_revision=ontology_base, statement_refs=sorted(active["statements"]),
                                withdrawn_statement_refs=sorted(withdrawn & {row["statement_ref"] for row in assignments}))
    with progress.phase("ONTOLOGY", {"total": len(active["statements"]), "unit_label": "条原述"}) as phase:
        runtime = ObservedRuntime(ontology_runtime, progress, "ONTOLOGY")
        ontology = align(store, ontology_request, runtime, check_basis=same_basis)
        batches = ontology["batch_receipts"]
        usage = _usage(sum(row.get("generation_requests", 0) for row in batches),
                       sum(row.get("simulated_requests", 0) for row in batches),
                       reports=[row.get("usage") for row in batches])
        ontology_ref = ontology["target_ontology_revision"]
        gaps = _gaps(ontology.get("execution_gaps", []))
        counts = dict(processed=len(ontology["processed_statement_refs"]), total=len(active["statements"]),
                      definitions=len(ontology["definition_changes"]), unit_label="条原述")
        status = ontology["execution_status"]
        artifacts = [run, *([ontology_ref] if ontology_ref else [])]
        if status in {"FAILED", "UNKNOWN_HOLD"}:
            progress.record("ONTOLOGY", "RUNNING", counts=counts, usage=usage, artifacts=artifacts, gaps=gaps)
            raise BuildStop(status, "ONTOLOGY_NOT_SETTLED")
        require(ontology_ref and ontology.get("publication_eligible"), "ONTOLOGY_NOT_PUBLICATION_ELIGIBLE")
        phase.update(counts=counts, usage=usage, artifacts=artifacts, gaps=gaps)
    upstream.extend(gaps)
    manifest_ref = ref("source_manifest", library, run, source_snapshot_ref, prepared["sources"])
    if not files:
        from ontoweave_index.repository import IndexRepository

        IndexRepository(store).register_source_manifest(library, manifest_ref, [],
            authority=dict(kind="EMPTY_PRODUCT_SOURCE_SNAPSHOT", run_ref=run, source_snapshot_ref=source_snapshot_ref))
    with progress.phase("FACT_ROUTING", {"total": len(active["statements"]), "unit_label": "条原述"}) as phase:
        routing = routing_request(library, ref("route", run), adopted, identity["identity_revision"], ontology_ref,
                                  ref("time_revision", ontology_ref), manifest_ref, active["statements"], trigger)
        if adopted:
            routing["withdrawn_statement_refs"] = sorted(withdrawn)
        bundle = prepare_initial_bundle(store, engine, routing)
        dispositions = {row["statement_ref"]: {"result": row["routing_result"], "rule_ref": row["rule_ref"]}
                        for row in bundle["result"]["statement_results"]}
        failure = prepare_for_publisher(store, identity["job_ref"], dispositions)
        require(failure is None, "IDENTITY_COMPATIBILITY_PROJECTION_FAILED")
        phase.update(counts=bundle["result"]["counts"], artifacts=[bundle["bundle_ref"]],
                     gaps=_gaps(bundle["result"]["gaps"]))

    settings.assert_owned()
    progress.record("PUBLICATION", "RUNNING", counts={"step": "INDEX_PREPARATION"})
    with progress.observe("PUBLICATION", lambda: _index_counts(store, library)):
        plan = prepare_publication(store, bundle, run_ref=run, upstream_gaps=upstream)
    settings.assert_owned()
    job = publisher.submit(plan["publication"])
    progress.record("PUBLICATION", "RUNNING", counts={"step": "PUBLICATION_CONFIRMATION"},
                    artifacts=[job, bundle["bundle_ref"]])
    publisher.apply(library, job, **{key: plan[key] for key in ("bundle", "graph_delta", "index_delta", "redirects")})
    require(progress.builds.settle_confirmed(library, run), "PRODUCT_PUBLICATION_CONFIRMATION_MISSING")
