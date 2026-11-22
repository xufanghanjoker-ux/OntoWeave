"""Adopt existing authenticated producer bytes in a new reception namespace."""
from copy import deepcopy
from ontoweave_cq.store import require,same_projection,sha
from ontoweave_cq_similarity.core import digest
from . import RECEPTION_NAMESPACES, V3_POLICY_VERSION
from .provenance import authenticate_delivery, authenticate_origins
from .repository import Reception

def replay_source(store,receiver,args):
    require(receiver.policy==V3_POLICY_VERSION,'REPLAY_REQUIRES_V3_NAMESPACE')
    namespace=getattr(args,'source_namespace','extraction_v2')
    owner=Reception(store, RECEPTION_NAMESPACES[namespace])
    old=owner.read_run(args.source_run_id)
    plan=deepcopy(old['plan']);plan.update(run_id=args.run_id,contract='ontoweave-open-replay/3',mode='REPLAY',producer_run_id=args.source_run_id,producer_policy=owner.policy,producer_namespace=owner.schema,reception_policy=receiver.policy,namespace=receiver.schema,producer_skill=plan.get('skill'),receiver_skill_generation=False)
    remap={}
    for task in plan['tasks']:
        task.pop('recovery_provenance', None)
        original=task['task_ref'];task['producer_task_ref']=original;task['task_ref']='extraction_task_'+digest([args.run_id,original,receiver.policy]);remap[original]=task['task_ref']
    plan['replayed_responses']=[dict(producer_response_ref=r['response_ref'],raw_sha256=r['sha256'],producer_task_ref=r['task_ref'],identity=r['identity']) for r in old['responses'] if not r['late']]
    # Verify source evidence before creating the new run.
    authenticate_origins(store,old,owner.policy,include_deliveries=True)
    payloads = []
    for r in old['responses']:
        if r['late']:continue
        raw=bytes.fromhex(r['raw_hex']);require(sha(raw)==r['sha256'],'PRODUCER_RAW_SHA_CHANGED')
        require(any(x['policy']==owner.policy and not x['late'] and x['response_ref']==r['response_ref'] and x['raw_sha256']==r['sha256'] for x in old['receipts']),'PRODUCER_RECEIPT_UNCONFIRMED')
        identity={**r['identity'],'producer_run_id':args.source_run_id,'producer_response_ref':r['response_ref']}
        delivery={**r['delivery'],'execution_mode':'REPLAY','producer_run_id':args.source_run_id}
        payloads.append((remap[r['task_ref']],identity,raw,delivery))
    receiver.create(plan,reuse=True)
    for task_ref,identity,raw,delivery in payloads:
        ref=receiver.archive(task_ref,identity,raw,delivery);receiver.receive(ref)
    for task in old['tasks']:
        status=task['status']
        hold=status if status in ('UNKNOWN_HOLD','NOT_DISPATCHED_UNKNOWN') else None
        receiver.settle_task(remap[task['task_ref']],final=True,force=hold)


def recover_run(receiver, run_id, revision):
    """Explicitly receive confirmed raw bodies and settle only authenticated tasks."""
    run = receiver.read_run(run_id)
    plan = run['plan']
    states = []
    origins = None
    for task in run['tasks']:
        ref = task['task_ref']
        responses = [r for r in run['responses'] if r['task_ref'] == ref]
        if task['frozen'] or revision != receiver.policy:
            for row in responses:
                if row['late'] or revision != receiver.policy or any(
                    r['response_ref'] == row['response_ref'] and r['policy'] == revision
                    for r in run['receipts']
                ):
                    receiver.receive(row['response_ref'], policy=revision)
            states.append(dict(task_ref=ref, status=task['status'], action='PRESERVE_SETTLEMENT'))
            continue
        active = [r for r in responses if not r['late']]
        returned = [r for r in active if r['delivery']['outcome'] == 'RETURNED']
        if not returned:
            states.append(dict(task_ref=ref, status=task['status'], action='HOLD_UNCONFIRMED'))
            continue
        require(any(t['task_ref'] == ref and same_projection(t, task['manifest']) for t in plan['tasks']),
                'RECOVERY_TASK_MANIFEST_CHANGED')
        if plan.get('producer_run_id'):
            if origins is None:
                origins = authenticate_origins(receiver.store, run, receiver.policy, include_deliveries=True)
            require(all(row['response_ref'] in origins for row in returned), 'RECOVERY_PRODUCER_UNAUTHENTICATED')
            expected = {r['producer_response_ref'] for r in plan['replayed_responses']
                        if r['producer_task_ref'] == task['manifest']['producer_task_ref']}
            ready = expected == {r['identity'].get('producer_response_ref') for r in active}
        else:
            with receiver.store.transaction(readonly=True) as (q, _):
                authenticated = set()
                for row in returned:
                    ledger = authenticate_delivery(q, receiver.policy, run_id, ref, row)
                    authenticated.add(row['identity']['request_ref'])
            ready = all(a['outcome'] == 'RETURNED' and a['request_ref'] in authenticated for a in ledger['attempts'])
        for row in returned:
            receiver.receive(row['response_ref'], policy=revision)
        if not ready or any(r['delivery']['outcome'] != 'RETURNED' for r in active):
            states.append(dict(task_ref=ref, status=task['status'], action='PRESERVE_CONFIRMED_AND_HOLD'))
            continue
        states.append({**receiver.settle_task(ref, final=True), 'action': 'SETTLE_CONFIRMED'})
    return states
