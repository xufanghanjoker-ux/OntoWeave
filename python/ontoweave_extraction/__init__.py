"""Source-scoped semantic candidates; no graph publication."""
POLICY_VERSION = 'business-labels/1-reception/2'

# Historical default stays v2. Every new v3 run selects its own policy explicitly.
V3_POLICY_VERSION = 'open-statements/1-reception/3'


RECEPTION_NAMESPACES = {
    'extraction_v2': POLICY_VERSION,
    'extraction_v3': V3_POLICY_VERSION,
}


def runtime_ref(policy, run_id, task_ref):
    version = 'v3' if policy == V3_POLICY_VERSION else 'v2'
    return f'extraction:{version}:{run_id}:{task_ref}'
