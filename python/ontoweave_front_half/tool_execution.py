"""Small host policy shared by roles with fixed authorization and material."""
from threading import Lock

from ontoweave_cq.store import require


class FixedMaterialRead:
    def __init__(self):
        self._lock = Lock()
        self.delivered = False

    def call(self, args, load):
        require(args == {}, "FIXED_MATERIAL_ARGUMENTS_UNBOUND")
        with self._lock:
            if self.delivered:
                return dict(material_already_in_context=True, execution_outcome="REUSED")
            material = load()
            self.delivered = True
            return dict(material=material)

STOP_ON_KNOWN_FAILURE = "STOP_ON_KNOWN_FAILURE"
CONTINUE_KNOWN_FAILURE = "CONTINUE_KNOWN_FAILURE"
FAILURE_POLICIES = {STOP_ON_KNOWN_FAILURE, CONTINUE_KNOWN_FAILURE}


def should_stop(receipt, policy):
    status = receipt["status"]
    if status in {"COMPLETED", "HELD_AFTER_TECHNICAL_FAILURE"}:
        return False
    return policy != CONTINUE_KNOWN_FAILURE or status != "FAILED" or receipt.get("failure_class") != "BATCH_FAILED_KNOWN"
