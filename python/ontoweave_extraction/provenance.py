"""Authenticate archived native delivery against its original producer."""

from ontoweave_cq.store import require, same_projection, sha
from ontoweave_cq_similarity.core import digest
from . import runtime_ref
from .protocol import business_messages, events
from .repository import Reception


def verified_record(q, run_id, kind, key, history_seq=None):
    if history_seq is None:
        sql = "SELECT payload,payload_sha FROM front_half.records WHERE run_id=%s AND kind=%s AND key=%s"
        params = [run_id, kind, key]
    else:
        sql = "SELECT payload,payload_sha FROM front_half.history WHERE run_id=%s AND kind=%s AND key=%s AND seq=%s"
        params = [run_id, kind, key, history_seq]
    row = q(sql, params).fetchone()
    require(row and digest(row['payload']) == row['payload_sha'], 'SOURCE_NATIVE_RECORD_UNAUTHENTICATED')
    return row['payload']


def authenticate_delivery(q, policy, run_id, task_ref, response, recovery=None):
    runtime = runtime_ref(policy, run_id, task_ref)
    identity = response['identity']
    ref = identity['request_ref']
    wire = verified_record(q, runtime, 'native_agent_wire_v1', ref)
    history_seq = identity.get('history_seq') if recovery else None
    require(identity.get('history_seq') is None or recovery, 'SOURCE_NATIVE_HISTORY_UNBOUND')
    raw = verified_record(q, runtime, 'native_agent_response_v1', ref, history_seq)
    invocation = wire['invocation_ref']
    require(wire['agent_scope'] == task_ref and wire['request_ref'] == raw['request_ref'] == ref
            and sha(wire['body_utf8']) == wire['body_sha256']
            and raw['invocation_ref'] == invocation
            and (not identity.get('invocation_ref') or identity['invocation_ref'] == invocation)
            and raw['complete_body'] and 200 <= raw['http_status'] < 300
            and not raw.get('redacted') and not raw.get('redaction_error')
            and sha(raw['body_utf8']) == raw['body_sha256'] == raw.get('stored_body_sha256', raw['body_sha256']), 'SOURCE_NATIVE_BYTES_UNAUTHENTICATED')
    known = response['delivery']['outcome'] == 'KNOWN_INCOMPLETE'
    messages = business_messages(raw['body_utf8'], known=known)
    terminal = [e for e in events(raw['body_utf8'].replace('\r\n', '\n'))
                if e.get('type') in ('response.completed', 'response.incomplete', 'response.failed', 'error')]
    payload = bytes.fromhex(response['raw_hex'])
    require(len(terminal) == 1 and terminal[0]['type'] == ('response.incomplete' if known else 'response.completed')
            and sha(payload) == response['sha256']
            and (any(m['message_id'] == identity.get('message_id')
                     and m['message_index'] == identity['message_index']
                     and m['text'].encode() == payload for m in messages)
                 or not known and not messages and not payload and identity['message_index'] == -1),
            'SOURCE_NATIVE_MESSAGE_CHANGED')
    ledger = verified_record(q, runtime, 'extraction_runtime', runtime)
    attempts = [a for a in ledger['attempts'] if a['request_ref'] == ref]
    require(len(attempts) == 1 and attempts[0]['agent_scope'] == task_ref
            and (attempts[0]['outcome'] in ('FAILED', 'RETURNED') if known else attempts[0]['outcome'] == 'RETURNED'), 'SOURCE_NATIVE_OUTCOME_UNCONFIRMED')
    if recovery:
        require(recovery['producer_run_id'] == run_id and recovery['producer_task_ref'] == task_ref
                and recovery['request_ref'] == ref and recovery['invocation_ref'] == invocation
                and recovery['response_body_sha256'] == raw['body_sha256']
                and recovery.get('history_seq') == history_seq
                and recovery['business_message_sha256'] == response['sha256']
                and recovery['request_wire_sha256'] == sha(wire['body_utf8']) == wire['body_sha256'],
                'SOURCE_NATIVE_RECOVERY_PROOF_CHANGED')
    if not known:
        native = response['delivery'].get('native_completion', {})
        require(native.get('status') == 'completed'
                and native.get('thread_id') == identity.get('thread_id')
                and native.get('turn_id') == identity.get('turn_id'), 'SOURCE_NATIVE_TURN_UNBOUND')
        rows = q("""SELECT payload,payload_sha FROM front_half.records
                    WHERE run_id=%s AND kind='native_agent_event_v1'
                    AND payload->>'invocation_ref'=%s
                    AND payload->'notification'->>'method'='turn/completed'""", [runtime, invocation]).fetchall()
        matching = [row for row in rows
                    if row['payload']['notification']['params'].get('threadId') == native['thread_id']
                    and row['payload']['notification']['params']['turn'].get('id') == native['turn_id']]
        require(any(digest(row['payload']) == row['payload_sha']
                    and row['payload']['notification']['params']['turn'].get('status') == 'completed'
                    and not row['payload']['notification']['params']['turn'].get('error') for row in matching),
                'SOURCE_NATIVE_TURN_UNCONFIRMED')
    return ledger


def authenticate_origins(store, run, policy, chain=(), *, include_deliveries=False):
    plan = run["plan"]
    require((policy, run["run_id"]) not in chain, "IDENTITY_PRODUCER_LINEAGE_CYCLE")
    accepted = {r["response_ref"] for r in run["receipts"]
                if r["policy"] == policy and r["items"] and not r["late"]}
    if include_deliveries:
        accepted.update(r["response_ref"] for r in run["responses"]
                        if not r["late"] and (
                            r["delivery"]["outcome"] == "RETURNED" or r["delivery"].get("certified_complete_message")
                        ))
    tasks = {t["task_ref"]: t["manifest"] for t in run["tasks"]}
    producer = plan.get("producer_run_id")
    origins = {}
    if producer is None:
        with store.transaction(readonly=True) as (q, _):
            for response in run["responses"]:
                if response["response_ref"] in accepted:
                    authenticate_delivery(q, policy, run["run_id"], response["task_ref"], response)
        return origins

    producer_policy = plan["producer_policy"]
    owner = Reception(store, producer_policy)
    require(plan.get("producer_namespace", owner.schema) == owner.schema, "IDENTITY_PRODUCER_NAMESPACE_MISMATCH")
    old = owner.read_run(producer)
    require(all(old["plan"].get(k) == plan.get(k) for k in
                ("upstream_run_id", "archive_id", "snapshot_ref", "similarity_plan_ref")),
            "IDENTITY_PRODUCER_SOURCE_MISMATCH")
    responses = {r["response_ref"]: r for r in old["responses"]}
    receipts = {r["response_ref"]: r for r in old["receipts"] if r["policy"] == producer_policy and not r["late"]}
    original_tasks = {t["task_ref"]: t["manifest"] for t in old["tasks"]}
    old_origins = authenticate_origins(store, old, producer_policy, (*chain, (policy, run["run_id"])))
    for row in run["responses"]:
        if row["response_ref"] not in accepted:
            continue
        identity = row["identity"]
        original = responses.get(identity.get("producer_response_ref"))
        task = tasks[row["task_ref"]]
        owner_task = task["producer_task_ref"]
        require(identity.get("producer_run_id") == producer and original and not original["late"]
                and original["task_ref"] == owner_task
                and same_projection(task["sources"], original_tasks[owner_task]["sources"])
                and same_projection(task["questions"], original_tasks[owner_task]["questions"]),
                "IDENTITY_PRODUCER_TASK_MISMATCH")
        receipt = receipts.get(original["response_ref"])
        proof = task.get("recovery_provenance")
        if proof:
            require((proof.get("history_seq") is not None and original["delivery"]["outcome"] == "FAILED")
                    or (proof.get("history_seq") is None and original["raw_hex"] == row["raw_hex"]),
                    "IDENTITY_RECOVERY_ORIGINAL_UNBOUND")
            require(proof == row["delivery"].get("original_transport_evidence")
                    and proof["producer_response_ref"] == original["response_ref"]
                    and original["identity"]["request_ref"] == identity["request_ref"],
                    "IDENTITY_RECOVERY_PROOF_UNBOUND")
            with store.transaction(readonly=True) as (q, _):
                authenticate_delivery(q, producer_policy, producer, owner_task, row, recovery=proof)
        else:
            require(receipt and original["sha256"] == row["sha256"] == receipt["raw_sha256"]
                    and original["raw_hex"] == row["raw_hex"]
                    and original["identity"]["request_ref"] == identity["request_ref"]
                    and original["delivery"]["outcome"] == row["delivery"]["outcome"],
                    "IDENTITY_PRODUCER_REPLAY_MISMATCH")
            if original["response_ref"] not in old_origins:
                require(not old["plan"].get("producer_run_id"), "IDENTITY_PRODUCER_LINEAGE_UNBOUND")
                with store.transaction(readonly=True) as (q, _):
                    authenticate_delivery(q, producer_policy, producer, owner_task, original)
        origins[row["response_ref"]] = dict(
            response=original, receipt=receipt, run_id=producer, namespace=owner.schema,
            items={(i["record"]["start"], i["record"]["end"]): i for i in (receipt or {}).get("items", [])}
            if original["sha256"] == row["sha256"] else {},
        )
    return origins


