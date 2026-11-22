"""Prepare, align and stage an explicit ontology bundle."""

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from time import perf_counter

from psycopg import InterfaceError, OperationalError

from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest
from ontoweave_identity.input import ref
from ontoweave_front_half.tool_execution import CONTINUE_KNOWN_FAILURE, STOP_ON_KNOWN_FAILURE, should_stop

from . import INPUT_CONTRACT, RESULT_CONTRACT
from .agent import batches, prepare_groups, refresh_batch
from .receiver import build_binding, receive
from .repository import OntologyRepository, combine_definition, component_key
from .signatures import SIMPLIFIED, group, source_ref
from .source import load_identity

TRIGGERS = {"INITIAL", "IDENTITY_CHANGED", "ONTOLOGY_CHANGED", "TIME_CHANGED", "SOURCE_CHANGED", "HUMAN_DECISION"}


def prepare(store, request, runtime_identity):
    require(request.get("contract") == INPUT_CONTRACT and request.get("library_ref")
            and request.get("run_ref") and request.get("identity_revision")
            and request.get("trigger", {}).get("kind") in TRIGGERS, "ONTOLOGY_INPUT_INVALID")
    library, base = request["library_ref"], request.get("ontology_revision")
    identity = load_identity(store, library, request["identity_revision"])
    previous = OntologyRepository(store).snapshot(library, base)
    chosen = request.get("statement_refs", sorted(identity["statements"]) if base is None else None)
    withdrawn = request.get("withdrawn_statement_refs", [])
    parents = {a["statement_ref"] for a in previous["assignments"]}
    require(isinstance(chosen, list) and len(set(chosen)) == len(chosen)
            and set(chosen) <= identity["statements"].keys() and isinstance(withdrawn, list)
            and len(set(withdrawn)) == len(withdrawn) and set(withdrawn) <= parents
            and not set(chosen).intersection(withdrawn), "ONTOLOGY_STATEMENT_SCOPE_INVALID")
    simplified = runtime_identity.get("alignment_contract") == SIMPLIFIED
    groups = prepare_groups(group(identity, chosen, simplified=simplified), previous["definitions"], runtime_identity)
    return dict(request=request, identity=identity, previous=previous, signatures=groups,
                statement_refs=sorted(chosen), withdrawn_statement_refs=sorted(withdrawn), simplified=simplified,
                input_sha256=digest([request, runtime_identity, [g["basis_sha256"] for g in groups]]))


def _unbound(library, group, reason):
    binding = build_binding(library, group, group["members"], [], "OPEN", reason=reason, method="PROGRAM")
    return [(m["target"], binding) for m in group["members"]]


def _cache(group, before, previous_bindings, warnings):
    rows = []
    for member in group["members"]:
        target = member["target"]
        key = (target["statement_ref"], component_key(target))
        old = before.get(key)
        if old is None:
            return []
        binding = previous_bindings[old["binding_ref"]]
        if binding.get("method") == "HUMAN":
            if (binding["alignment_signature_ref"], binding["basis_sha256"]) != (
                    group["alignment_signature_ref"], group["basis_sha256"]):
                warnings.append(dict(code="HUMAN_BINDING_BASIS_CHANGED", statement_ref=target["statement_ref"],
                                     binding_ref=binding["binding_ref"], can_continue=True))
            rows.append((target, binding))
        elif (binding.get("method") == "AGENT"
              and binding["alignment_signature_ref"] == group["alignment_signature_ref"]
              and binding["basis_sha256"] == group["basis_sha256"]):
            rows.append((target, binding))
    return rows


def collect_work(prepared, runtime_identity):
    library = prepared["request"]["library_ref"]
    before = {(a["statement_ref"], component_key(a)): a for a in prepared["previous"]["assignments"]}
    previous_bindings = {b["binding_ref"]: b for b in prepared["previous"]["bindings"]}
    warnings, mapped, pending = [], [], []
    groups = prepared["signatures"]
    cache_hits = 0
    for signature in groups:
        cached = _cache(signature, before, previous_bindings, warnings)
        mapped.extend(cached)
        if cached:
            cache_hits += len(cached)
            keys = {component_key(t) + t["statement_ref"] for t, _ in cached}
            remaining = [m for m in signature["members"]
                         if component_key(m["target"]) + m["target"]["statement_ref"] not in keys]
            if not remaining:
                continue
            signature = {**signature, "members": remaining}
        if reason := signature["blocked_reason"]:
            mapped.extend(_unbound(library, signature, reason))
            warnings.append(dict(code=reason, signature_ref=signature["alignment_signature_ref"], can_continue=True))
        else:
            pending.append(signature)

    work, oversized = batches(pending, runtime_identity)
    prepared["undispatched_signatures"] = oversized
    for signature in oversized:
        mapped.extend(_unbound(library, signature, "MATERIAL_OVER_BUDGET"))
        warnings.append(dict(code="MATERIAL_OVER_BUDGET", signature_ref=signature["alignment_signature_ref"],
                             can_continue=True))
    return work, mapped, warnings, cache_hits


def align(store, request, runtime, *, check_basis=None, resume=False, recovery_from=None, recovery_output=None, certified_recovery=None):
    require(runtime.identity.get("mode") != "REAL" or callable(check_basis), "ONTOLOGY_REAL_BASIS_CHECK_REQUIRED")
    operation_started = perf_counter()
    repository = OntologyRepository(store)
    prepared = prepare(store, request, runtime.identity)
    library, run = request["library_ref"], request["run_ref"]
    policy = getattr(runtime, "failure_policy", STOP_ON_KNOWN_FAILURE)
    work, mapped, warnings, cache_hits = collect_work(prepared, runtime.identity)
    certified = {}
    recovery = None
    if recovery_from:
        require(not prepared["simplified"], "ONTOLOGY_RECOVERY_REQUIRES_MATCHING_LEGACY_MATERIAL")
        from .recovery import certify, write_plan
        recovery, certified = certified_recovery or certify(store, prepared, work, runtime.identity, recovery_from)
        require(recovery["request"] == request and recovery["target_runtime"] == runtime.identity
                and recovery["predecessor_run_ref"] == recovery_from
                and recovery["target_input_sha256"] == prepared["input_sha256"], "ONTOLOGY_RECOVERY_BASIS_CHANGED")
        write_plan(recovery_output, recovery)
        require(recovery["dispatch_eligible"], "ONTOLOGY_RECOVERY_BLOCKED")
    if recovery_from or policy != STOP_ON_KNOWN_FAILURE:
        prepared["input_sha256"] = digest([prepared["input_sha256"], policy, recovery_from,
                                           recovery and recovery["plan_sha256"]])
    pin = prepared["input_sha256"]
    existing = repository.by_run(library, run, pin)
    if existing:
        return existing
    input_receipt = dict(input_sha256=pin, request=request, runtime=runtime.identity)
    if recovery or policy != STOP_ON_KNOWN_FAILURE:
        input_receipt.update(execution_policy=policy, recovery_plan_sha256=recovery and recovery["plan_sha256"])
    repository.save_receipt(library, run, "input", input_receipt)
    claimed = repository.claim_batch(library, run, "run-owner")
    require(claimed or resume, "ONTOLOGY_RUN_RECONCILE_REQUIRED")
    stale = repository.receipt(library, run, "stale")
    if stale:
        return _stale_response(stale["result"])
    outcomes, proposals, changes = [], {}, {}
    prior_receipts, frozen_inputs = {}, {}
    accepted_replays = {}
    recent = {d["definition_ref"]: d for d in prepared["previous"]["definitions"]}
    shortlist_lock = Lock()
    actual_signatures = list(prepared["undispatched_signatures"])
    for batch in work:
        key = batch["batch_ref"]
        frozen = repository.receipt(library, run, "dispatch-input:" + key) if prepared["simplified"] else None
        if frozen:
            require(frozen["slot_ref"] == key and frozen["material_sha256"] == sha(frozen["batch"]["material"]),
                    "ONTOLOGY_DISPATCH_MATERIAL_CHANGED")
            frozen_inputs[key] = frozen["batch"]
        settled = repository.receipt(library, run, "batch:" + key)
        if key in certified:
            expected = certified[key]
            require(not settled or settled == expected, "ONTOLOGY_RECOVERY_RECEIPT_CHANGED")
            accepted_replays[key] = receive(library, batch, expected["messages"])
            repository.save_receipt(library, run, "batch:" + key, expected)
            prior_receipts[key] = expected
        elif settled:
            prior_receipts[key] = settled
            if prepared["simplified"] and settled["status"] == "COMPLETED":
                require(frozen, "ONTOLOGY_DISPATCH_MATERIAL_MISSING")
                for definition in receive(library, frozen["batch"], settled["messages"])["definitions"]:
                    ref_key = definition["definition_ref"]
                    recent[ref_key] = combine_definition(recent.get(ref_key), definition)
        elif repository.receipt(library, run, "dispatch:" + key):
            prior_receipts[key] = dict(status="UNKNOWN_HOLD", error="ONTOLOGY_UNSETTLED_DISPATCH")
    stop = Event()
    if any(should_stop(r, policy) for r in prior_receipts.values()):
        stop.set()

    queued = perf_counter()

    def judge(batch):
        key = batch["batch_ref"]
        actual = frozen_inputs.get(key, batch)
        if key in prior_receipts:
            return actual, prior_receipts[key]
        if stop.is_set():
            return actual, dict(status="HELD_AFTER_TECHNICAL_FAILURE")
        if not repository.claim_batch(library, run, key):
            stop.set()
            return actual, dict(status="UNKNOWN_HOLD", error="ONTOLOGY_UNSETTLED_DISPATCH")
        started = perf_counter()
        if prepared["simplified"] and key not in frozen_inputs:
            with shortlist_lock:
                definitions = list(recent.values())
            actual = refresh_batch(batch, definitions, runtime.identity)
            repository.save_receipt(library, run, "dispatch-input:" + key, dict(
                slot_ref=key, material_sha256=sha(actual["material"]), batch=actual))
        try:
            receipt = runtime.invoke(store, {**actual, "run_ref": run}, stop)
        except Exception as exc:
            receipt = dict(status="UNKNOWN_HOLD", error=getattr(exc, "code", type(exc).__name__))
        receipt = {**receipt, "queue_wait_ms": (started-queued)*1000}
        if should_stop(receipt, policy):
            stop.set()
        repository.save_receipt(library, run, "batch:" + key, receipt)
        if prepared["simplified"] and receipt["status"] == "COMPLETED":
            accepted = receive(library, actual, receipt["messages"])
            with shortlist_lock:
                for definition in accepted["definitions"]:
                    ref_key = definition["definition_ref"]
                    recent[ref_key] = combine_definition(recent.get(ref_key), definition)
        return actual, receipt

    reception_ms = 0
    execution_gaps = [dict(reason_code="MATERIAL_OVER_BUDGET", signature_ref=w["signature_ref"])
                      for w in warnings if w["code"]=="MATERIAL_OVER_BUDGET"]
    with ThreadPoolExecutor(max_workers=min(4, max(1, runtime.concurrency))) as pool:
        for slot, (batch, receipt) in zip(work, pool.map(judge, work), strict=True):
            if prepared["simplified"]:
                actual_signatures.extend(entry["group"] for entry in batch["labels"]["signatures"].values())
            status = receipt["status"]
            outcomes.append(dict(batch_ref=batch["batch_ref"], status=status,
                                 material_tokens=batch["material_tokens"],
                                 simulated_requests=receipt.get("simulated_requests", 0),
                                 generation_requests=receipt.get("generation_requests", 0),
                                 usage=receipt.get("usage"), origin=receipt.get("origin","NATIVE"),
                                 failure_class=receipt.get("failure_class"), reason=receipt.get("receipt",{}).get("first_failure_reason") or receipt.get("error"), queue_wait_ms=receipt.get("queue_wait_ms"),
                                 timing_ms=receipt.get("timing_ms")))
            if prepared["simplified"]:
                outcomes[-1].update(slot_ref=slot["batch_ref"], material_sha256=sha(batch["material"]))
            if status != "COMPLETED":
                for entry in batch["labels"]["signatures"].values():
                    mapped.extend(_unbound(library, entry["group"], status))
                classification = receipt.get("failure_class", "UNKNOWN_HOLD" if status == "UNKNOWN_HOLD"
                                             else "NOT_DISPATCHED" if status == "HELD_AFTER_TECHNICAL_FAILURE" else "FATAL")
                execution_gaps.append(dict(reason_code=classification, batch_ref=batch["batch_ref"], status=status,
                     statement_refs=sorted({m["target"]["statement_ref"] for entry in batch["labels"]["signatures"].values()
                                            for m in entry["group"]["members"]})))
                warnings.append(dict(code=status, batch_ref=batch["batch_ref"], can_continue=False))
                continue
            accepting = perf_counter()
            accepted = accepted_replays.get(batch["batch_ref"]) or receive(library, batch, receipt["messages"])
            reception_ms += (perf_counter()-accepting)*1000
            mapped.extend(accepted["mapped"])
            warnings.extend(accepted["warnings"])
            proposals.update((p["proposal_ref"], p) for p in accepted["proposals"])
            for definition in accepted["definitions"]:
                key = definition["definition_ref"]
                changes[key] = combine_definition(changes.get(key), definition)
    statuses = {r["status"] for r in outcomes}
    if "UNKNOWN_HOLD" in statuses:
        status = "UNKNOWN_HOLD"
    elif "FAILED" in statuses:
        partial_allowed = (policy == CONTINUE_KNOWN_FAILURE and "COMPLETED" in statuses
                           and all(g["reason_code"] in {"BATCH_FAILED_KNOWN","MATERIAL_OVER_BUDGET"} for g in execution_gaps))
        status = "PARTIAL" if partial_allowed else "FAILED"
    elif execution_gaps:
        status = "PARTIAL"
    else:
        status = "COMPLETED"

    result = _result(prepared, mapped, changes, proposals, warnings, outcomes, status, cache_hits,
                     execution_gaps=execution_gaps, policy=policy, recovery=recovery)
    saving = perf_counter()
    try:
        signatures = {(row["alignment_signature_ref"], row["basis_sha256"]): row
                      for row in [*prepared["signatures"], *actual_signatures]}
        sealed = repository.save(result, request.get("ontology_revision"), pin, signatures.values(), check_basis=check_basis)
    except (OperationalError, InterfaceError):
        # A disconnected commit could have succeeded. Confirm by operation identity only.
        try:
            sealed = repository.by_run(library, run, pin)
        except (OperationalError, InterfaceError):
            sealed = None
        return sealed or {**result, "execution_status": "UNKNOWN_HOLD", "publication_eligible": False, "target_ontology_revision": None,
                          "warnings": [*warnings, dict(code="ONTOLOGY_COMMIT_UNKNOWN", can_continue=False)]}
    timing = dict(material_and_recovery=(queued-operation_started)*1000,
                  business_reception=reception_ms, ontology_pg_save=(perf_counter()-saving)*1000,
                  total_wall=(perf_counter()-operation_started)*1000)
    repository.save_receipt(library, run, "operation-timing", timing)
    return sealed if sealed is not None else _stale_response(result)


def _stale_response(result):
    return {**result, "execution_status": "PARTIAL", "publication_eligible": False, "target_ontology_revision": None,
            "warnings": [*result["warnings"], dict(code="ONTOLOGY_BASIS_STALE", can_continue=False)]}


def _result(prepared, mapped, changes, proposals, warnings, outcomes, status, cache_hits, *,
            execution_gaps=(), policy=STOP_ON_KNOWN_FAILURE, recovery=None):
    request = prepared["request"]
    before = defaultdict(set)
    after = defaultdict(set)
    bindings, assignments, open_statements = {}, [], set()
    processed = sorted(set(prepared["statement_refs"]) | set(prepared["withdrawn_statement_refs"]))
    for assignment in prepared["previous"]["assignments"]:
        if assignment["statement_ref"] in processed:
            before[assignment["statement_ref"]].add(digest(assignment))
    qualifiers = defaultdict(dict)
    for target, binding in mapped:
        if target["component_role"] == "QUALIFIER_ROLE":
            statement = target["statement_ref"]
            for role in binding["qualifier_roles"]:
                key = role["source_role_key"]
                existing = qualifiers[statement].get(key)
                if existing and existing["semantic_role"] != role["semantic_role"]:
                    qualifiers[statement][key] = {**role, "semantic_role": "UNKNOWN"}
                else:
                    qualifiers[statement][key] = role
    for target, binding in mapped:
        statement = target["statement_ref"]
        if target["component_role"] == "MAIN_PROPERTY":
            if prepared["simplified"]:
                raw = prepared["identity"]["statements"][statement]["candidate"].get("qualifiers", [])
                by_role = {row["source_role_key"]: row for row in binding["qualifier_roles"]}
                for qualifier in raw:
                    key = qualifier.get("role") or qualifier.get("role_raw")
                    if key:
                        by_role.setdefault(key, dict(source_role_key=key, semantic_role="UNKNOWN",
                                                     role_definition_ref=None, evidence_statement_refs=[]))
                roles = [by_role[k] for k in sorted(by_role)]
            else:
                roles = [qualifiers[statement][k] for k in sorted(qualifiers[statement])]
            if roles != binding["qualifier_roles"]:
                payload = {**binding, "qualifier_roles": roles}
                del payload["binding_ref"]
                binding = dict(binding_ref=ref("binding", [request["library_ref"], payload]), **payload)
        key = binding["binding_ref"]
        assignment = dict(**target, binding_ref=key)
        bindings[key] = binding
        assignments.append(assignment)
        after[statement].add(digest(assignment))
        if target["component_role"] == "MAIN_PROPERTY" and binding["binding_state"] != "BOUND":
            open_statements.add(statement)
    require(set(after) == set(prepared["statement_refs"]) and len(assignments) == sum(map(len, after.values())),
            "ONTOLOGY_ASSIGNMENT_COVERAGE")
    result = dict(
        contract=RESULT_CONTRACT, library_ref=request["library_ref"], run_ref=request["run_ref"],
        base_view_revision=request.get("base_view_revision"), identity_revision=request["identity_revision"],
        execution_status=status, definition_changes=[changes[k] for k in sorted(changes)],
        bindings=[bindings[k] for k in sorted(bindings)], statement_assignments=sorted(assignments, key=digest),
        constraint_proposals=[proposals[k] for k in sorted(proposals)],
        open_statement_refs=sorted(open_statements), processed_statement_refs=processed,
        withdrawn_statement_refs=prepared["withdrawn_statement_refs"],
        affected_statement_refs=[s for s in processed if before[s] != after[s]], warnings=warnings,
        batch_receipts=outcomes, cache_hits=cache_hits,
        execution_policy=policy, execution_gaps=list(execution_gaps),
        content_warning_count=len([w for w in warnings if w["code"] not in
                                  ("NO_SUPPORTED_SHAPE","CANDIDATES_OVER_BUDGET","MATERIAL_OVER_BUDGET",
                                   "FAILED","UNKNOWN_HOLD","HELD_AFTER_TECHNICAL_FAILURE")]),
        publication_eligible=status in ("COMPLETED","PARTIAL"),
        recovery_plan_sha256=recovery and recovery["plan_sha256"],
    )
    if prepared["simplified"]:
        context = {}
        for statement_ref in prepared["statement_refs"]:
            statement = prepared["identity"]["statements"][statement_ref]
            candidate = statement["candidate"]
            context[statement_ref] = dict(
                status="RAW_PRESERVED", qualifiers=candidate.get("qualifiers", []),
                times=candidate.get("times", []), endpoints=statement["endpoints"],
                **{key: candidate[key] for key in ("negated", "modality", "attribution", "statement_kind",
                                                    "extensions", "extras", "timezone", "time_precision")
                   if key in candidate})
        result.update(alignment_contract=SIMPLIFIED, statement_context=context)
    return dict(target_ontology_revision=ref("ontology_revision", [prepared["input_sha256"], result]), **result)


def change_plan(store, library, revision, *, definition_refs=(), source_refs=(), statement_refs=()):
    """Return local statement dependencies from an explicit immutable revision."""
    repository = OntologyRepository(store)
    snapshot = repository.snapshot(library, revision)
    definitions, sources, affected = set(definition_refs), set(source_refs), set(statement_refs)
    via_binding = {b["binding_ref"] for b in snapshot["bindings"] if b["definition_ref"] in definitions}
    affected.update(a["statement_ref"] for a in snapshot["assignments"] if a["binding_ref"] in via_binding)
    if sources:
        with store.transaction(readonly=True) as (q, _):
            for binding in snapshot["bindings"]:
                row = q("""SELECT payload FROM ontology_v1.alignment_signatures
                           WHERE (library_ref,signature_ref,basis_sha256)=(%s,%s,%s)""",
                        [library, binding["alignment_signature_ref"], binding["basis_sha256"]]).fetchone()
                affected.update(m["target"]["statement_ref"] for m in row["payload"]["members"]
                                if any(source_ref(source) in sources for source in m["statement"]["source_refs"]))
    return dict(ontology_revision=revision, affected_statement_refs=sorted(affected))

