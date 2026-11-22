"""Certify an ontology replay from immutable PG-native evidence."""
import json

from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest
from ontoweave_extraction.protocol import business_messages, events
from ontoweave_extraction.provenance import verified_record

from .repository import ROOT, OntologyRepository
from .receiver import receive

# Explicit adapter lineage. Business interpretation must still match the pinned
# producer and the exact material, labels and source of each reconstructed batch.
HISTORY = ROOT / "local-runs/ontology-facts-ui-integration-v1/real-acceptance-v2"
PRODUCER_PINS = {
    HISTORY / "publication/handoff/provider-material-lock.json":
        "d80e2905f1a5dde75c217ae7194cf40234ffea07c54070260303c4e839de4197",
    HISTORY / "validation/g2-passed.json":
        "7df0d5218b96ced8c85b3c22d071e01aa07fa4919b9c0c9c48f94c710f4eb3aa",
}
SEMANTIC_FILES = (
    "docs/skill-drafts/ontoweave-ontology-alignment-v1/SKILL.md",
    "python/ontoweave_ontology/agent.py",
    "python/ontoweave_ontology/candidates.py",
    "python/ontoweave_ontology/material_context.py",
    "python/ontoweave_ontology/receiver.py",
    "python/ontoweave_ontology/signatures.py",
    "python/ontoweave_ontology/source.py",
)
RUNTIME_KEYS = ("model", "reasoning_effort", "skill_sha256", "runtime_lock_sha256")


def _predecessor(old, target):
    records = []
    for path, expected in PRODUCER_PINS.items():
        raw = path.read_bytes()
        require(sha(raw) == expected, "ONTOLOGY_REPLAY_PREDECESSOR_LOCK_CHANGED")
        records.append(json.loads(raw))
    files = {**records[1]["pins"], **records[0]["files"]}
    pins = {name: files.get(name) for name in SEMANTIC_FILES}
    require(all(pin and sha((ROOT / file).read_bytes()) == pin for file, pin in pins.items()),
            "ONTOLOGY_REPLAY_SEMANTIC_FILES_CHANGED")
    adapters = {"adapter_sha256": files["python/ontoweave_ontology/native.mjs"],
                "host_adapter_sha256": files["python/ontoweave_ontology/native.py"],
                "bridge_sha256": files["web/native-agent-runtime-v1.mjs"]}
    require(all(old.get(k) == v for k, v in adapters.items()) and
            all(old.get(k) and old[k] == target.get(k) for k in RUNTIME_KEYS),
            "ONTOLOGY_REPLAY_RUNTIME_MISMATCH")
    return pins


def _label_basis(batch):
    return {
        "definitions": batch["labels"]["definitions"],
        "signatures": {
            label: {**entry, "group": {k: v for k, v in entry["group"].items() if k != "basis_sha256"}}
            for label, entry in batch["labels"]["signatures"].items()
        },
    }


def _received_basis(received):
    mapped = [(target, {k: v for k, v in binding.items() if k not in ("basis_sha256", "binding_ref")})
              for target, binding in received["mapped"]]
    return digest({**received, "mapped": mapped})


def _judgment_rows(messages, labels):
    count = 0
    for message in messages:
        for line in message["text"].splitlines():
            try:
                row = json.loads(line)
                count += isinstance(row, dict) and row.get("signature") in labels
            except (ValueError, TypeError):
                pass
    return count


def _native_evidence(q, saved, batch, old_runtime):
    ledger_ref = saved["runtime_run_ref"]
    ledger = verified_record(q, ledger_ref, "extraction_runtime", ledger_ref)
    receipt = saved["receipt"]
    archived = verified_record(q, ledger_ref, "ontology_native_receipt", batch["batch_ref"])
    require(archived["receipt"] == receipt and receipt["agent_scope"] == batch["batch_ref"]
            and receipt["run_id"] == ledger_ref and receipt["origin"] == "CODEX_NATIVE_APP_SERVER"
            and receipt["model"] == old_runtime["model"]
            and receipt["runtime_binding"]["lock_sha256"] == old_runtime["runtime_lock_sha256"]
            and any(s["sha256"] == old_runtime["skill_sha256"] for s in receipt["skills"]),
            "ONTOLOGY_REPLAY_NATIVE_RECEIPT_CHANGED")
    invocation = receipt["invocation_ref"]
    attempts = ledger["attempts"]
    if any(a["outcome"] in ("RESERVED", "UNKNOWN") for a in attempts):
        return dict(unknown=True)
    require([a["request_ref"] for a in attempts] == receipt["request_refs"], "ONTOLOGY_REPLAY_REQUEST_SCOPE_CHANGED")
    evidence, material_deliveries = [], []
    for attempt in attempts:
        ref = attempt["request_ref"]
        wire = verified_record(q, ledger_ref, "native_agent_wire_v1", ref)
        response = verified_record(q, ledger_ref, "native_agent_response_v1", ref)
        require(wire["invocation_ref"] == response["invocation_ref"] == invocation
                and wire["request_ref"] == response["request_ref"] == ref
                and wire["agent_scope"] == attempt["agent_scope"] == batch["batch_ref"]
                and sha(wire["body_utf8"]) == wire["body_sha256"]
                and response["complete_body"] and not response.get("redacted") and not response.get("redaction_error")
                and sha(response["body_utf8"]) == response["body_sha256"]
                == response.get("stored_body_sha256", response["body_sha256"]),
                "ONTOLOGY_REPLAY_NATIVE_BYTES_CHANGED")
        body = json.loads(wire["body_utf8"])
        require(body["model"] == old_runtime["model"] and body["reasoning"]["effort"] == old_runtime["reasoning_effort"],
                "ONTOLOGY_REPLAY_WIRE_MODEL_CHANGED")
        delivered_calls = {c["call_id"]: c for prior in evidence for c in prior["calls"]}
        for item in body["input"]:
            if item.get("type") != "function_call_output" or not isinstance(item.get("output"), str):
                continue
            try:
                obj = json.loads(item["output"].split("Output:", 1)[-1])
            except ValueError:
                continue
            if isinstance(obj, dict) and "material" in obj:
                original = delivered_calls.get(item["call_id"])
                require(original and original.get("name", "").endswith("ontology_read_material")
                        and digest(obj["material"]) == digest(json.loads(batch["material"])),
                        "ONTOLOGY_REPLAY_MATERIAL_CHANGED")
                material_deliveries.append(dict(call_id=item["call_id"], request_ref=ref,
                                                material_sha256=digest(obj["material"])))
        frames = events(response["body_utf8"].replace("\r\n", "\n")) if 200 <= response["http_status"] < 300 else []
        terminals = [e for e in frames if e["type"] in ("response.completed", "response.failed", "response.incomplete", "error")]
        terminal = terminals[0] if len(terminals) == 1 else {}
        if attempt["outcome"] == "RETURNED":
            require(response.get("sse_metrics", {}).get("completion_seen")
                    and terminal.get("type") == "response.completed"
                    and terminal["response"]["status"] == "completed", "ONTOLOGY_REPLAY_SSE_UNCONFIRMED")
        require(attempt["outcome"] in ("RETURNED", "FAILED"), "ONTOLOGY_REPLAY_ATTEMPT_UNCONFIRMED")
        payload = terminal.get("response", {})
        evidence.append(dict(request_ref=ref, outcome=attempt["outcome"], wire_sha256=wire["body_sha256"],
                             response_sha256=response["body_sha256"], usage=payload.get("usage"),
                             calls=[c for c in payload.get("output", []) if c.get("type") == "function_call"],
                             messages=business_messages(response["body_utf8"]) if attempt["outcome"] == "RETURNED" else []))
    if saved["status"] != "COMPLETED":
        require(saved["status"] == "FAILED" and not saved.get("messages")
                and not any(row["messages"] for row in evidence), "ONTOLOGY_REPLAY_FAILED_HAS_BUSINESS_OUTPUT")
        return dict(requests=evidence, material_deliveries=material_deliveries)
    final = saved["raw_final"]
    last = evidence[-1]
    require(archived.get("complete") and receipt["status"] == "SUCCEEDED" and receipt["program_owned_output"]
            and all(r["outcome"] == "RETURNED" for r in evidence) and material_deliveries
            and last["request_ref"] == final["request_ref"] and last["response_sha256"] == final["transport_sha256"]
            and last["messages"] == saved["messages"] == final["messages"] and bool(last["messages"]),
            "ONTOLOGY_REPLAY_BUSINESS_MESSAGE_CHANGED")
    completion = final["native_completion"]
    notices = q("""SELECT key,payload,payload_sha FROM front_half.records WHERE run_id=%s
                  AND kind='native_agent_event_v1' AND payload->>'invocation_ref'=%s
                  AND payload->'notification'->>'method'='turn/completed'""", [ledger_ref, invocation]).fetchall()
    matched = []
    for row in notices:
        params = row["payload"]["notification"]["params"]
        turn = params["turn"]
        if (digest(row["payload"]) == row["payload_sha"] and params["threadId"] == completion["thread_id"] == receipt["thread_id"]
                and turn["id"] == completion["turn_id"] == receipt["turn_id"]
                and turn["status"] == completion["status"] == "completed" and not turn.get("error")):
            matched.append(row["key"])
    require(len(matched) == 1, "ONTOLOGY_REPLAY_TURN_UNCONFIRMED")
    return dict(requests=evidence, material_deliveries=material_deliveries,
                invocation_ref=invocation, native_completion_event=matched[0], messages=last["messages"])


def certify(store, prepared, work, runtime, predecessor):
    from .service import collect_work, prepare

    request = prepared["request"]
    library, run = request["library_ref"], request["run_ref"]
    require(predecessor != run, "ONTOLOGY_REPLAY_RUN_MUST_CHANGE")
    repository = OntologyRepository(store)
    with store.transaction(readonly=True) as (q, _):
        rows = q("""SELECT receipt_key,payload,sha256 FROM ontology_v1.run_receipts
                    WHERE library_ref=%s AND run_ref=%s ORDER BY receipt_key""", [library, predecessor]).fetchall()
    require(all(digest(r["payload"]) == r["sha256"] for r in rows), "ONTOLOGY_REPLAY_RECEIPT_HASH_CHANGED")
    receipts = {r["receipt_key"]: r["payload"] for r in rows}
    require("input" in receipts and "final" in receipts, "ONTOLOGY_REPLAY_PREDECESSOR_UNSEALED")
    original = receipts["input"]
    require(original["request"] == {**request, "run_ref": predecessor}, "ONTOLOGY_REPLAY_SOURCE_OR_IDENTITY_CHANGED")
    semantic = _predecessor(original["runtime"], runtime)
    historical_result = repository.by_run(library, predecessor, original["input_sha256"])
    require(historical_result and receipts["final"]["result_sha256"] == digest(historical_result)
            and receipts["final"]["status"] == historical_result["execution_status"], "ONTOLOGY_REPLAY_FINAL_CHANGED")
    prior = prepare(store, original["request"], original["runtime"])
    require(prior["input_sha256"] == original["input_sha256"]
            and digest(prior["previous"]) == digest(prepared["previous"]), "ONTOLOGY_REPLAY_DEFINITION_BASIS_CHANGED")
    prior_work, _, _, _ = collect_work(prior, original["runtime"])
    require(len(prior_work) == len(work) and
            [b["batch_ref"] for b in prior_work] == [b["batch_ref"] for b in historical_result["batch_receipts"]],
            "ONTOLOGY_REPLAY_WORK_SHAPE_CHANGED")
    decisions, accepted = [], {}
    with store.transaction(readonly=True) as (q, _):
        for previous, current, result in zip(prior_work, work, historical_result["batch_receipts"], strict=True):
            old_id, new_id = previous["batch_ref"], current["batch_ref"]
            entry = dict(predecessor_batch_ref=old_id, target_batch_ref=new_id, material_sha256=sha(current["material"]),
                         label_basis_sha256=digest(_label_basis(current)), previous_status=result["status"],
                         predecessor_basis=[v["group"]["basis_sha256"] for v in previous["labels"]["signatures"].values()],
                         target_basis=[v["group"]["basis_sha256"] for v in current["labels"]["signatures"].values()])
            saved = receipts.get("batch:" + old_id)
            equivalent = (previous["material"] == current["material"] and _label_basis(previous) == _label_basis(current))
            if not equivalent:
                entry.update(classification="REPLAY_INCOMPATIBLE", reason="MATERIAL_OR_LABELS_CHANGED")
            elif result["status"] == "UNKNOWN_HOLD" or not saved and "dispatch:" + old_id in receipts:
                entry.update(classification="HOLD_UNKNOWN")
            elif saved:
                try:
                    proof = _native_evidence(q, saved, previous, original["runtime"])
                    messages = proof.pop("messages", None)
                    historical_requests = proof.pop("requests", [])
                    entry.update(proof=proof, historical_requests=[{k: v for k, v in r.items() if k not in ("calls", "messages")}
                                                                  for r in historical_requests])
                    if proof.get("unknown"):
                        entry.update(classification="HOLD_UNKNOWN")
                    elif messages:
                        prior_received = _received_basis(receive(library, previous, messages))
                        target_received = _received_basis(receive(library, current, messages))
                        require(prior_received == target_received, "ONTOLOGY_REPLAY_RECEIVER_OUTPUT_CHANGED")
                        entry.update(classification="AUTHENTICATED_REPLAY", received_basis_sha256=target_received,
                                     message_sha256=[sha(m["text"]) for m in messages],
                                     business_lines=_judgment_rows(messages, current["labels"]["signatures"]))
                        accepted[new_id] = dict(status="COMPLETED", origin="AUTHENTICATED_REPLAY",
                                                 generation_requests=0, simulated_requests=0, messages=messages,
                                                 replay=dict(predecessor_run_ref=predecessor, target_run_ref=run,
                                                             receiver_sha256=semantic["python/ontoweave_ontology/receiver.py"],
                                                             **entry))
                    else:
                        entry.update(classification="NEW_ATTEMPT_ELIGIBLE")
                except (ValueError, KeyError, TypeError, IndexError) as error:
                    entry.update(classification="REPLAY_INCOMPATIBLE", reason=getattr(error, "code", str(error)))
                except Exception as error:
                    if not getattr(error, "code", None):
                        raise
                    entry.update(classification="REPLAY_INCOMPATIBLE", reason=error.code)
            elif result["status"] == "HELD_AFTER_TECHNICAL_FAILURE":
                entry.update(classification="NEW_ATTEMPT_ELIGIBLE")
            else:
                entry.update(classification="REPLAY_INCOMPATIBLE", reason="PREDECESSOR_RECEIPT_MISSING")
            decisions.append(entry)
    eligible = all(row["classification"] in ("AUTHENTICATED_REPLAY", "NEW_ATTEMPT_ELIGIBLE") for row in decisions)
    plan = dict(contract="ontoweave-ontology-recovery/1", library_ref=library, predecessor_run_ref=predecessor,
                target_run_ref=run, request=request, predecessor_runtime=original["runtime"], target_runtime=runtime,
                semantic_pins=semantic, frozen_candidate_definitions_sha256=digest(prior["previous"]["definitions"]),
                predecessor_input_sha256=original["input_sha256"], target_input_sha256=prepared["input_sha256"],
                predecessor_receipts_sha256=digest(rows), dispatch_eligible=eligible, batches=decisions)
    return {**plan, "plan_sha256": digest(plan)}, accepted


def write_plan(path, plan):
    if path is None:
        return
    raw = (json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    try:
        with path.open("xb") as stream:
            stream.write(raw)
    except FileExistsError:
        require(path.read_bytes() == raw, "ONTOLOGY_RECOVERY_PLAN_ALREADY_EXISTS")

