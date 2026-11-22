"""Send complete batches to the explicit, version-checked Rust executable."""

import json
from pathlib import Path
import subprocess

from ontoweave_cq.store import CQStoreError, require
from ontoweave_cq_similarity.core import digest


class RustEngine:
    def __init__(self, binary, timeout=60):
        self.binary = Path(binary).resolve(strict=True)
        self.timeout = timeout

    def __call__(self, operation, payload):
        request_id = digest([operation, payload])
        request = dict(wire_version="lightog-core/0.1", request_id=request_id,
                       module="temporal_core_v1", operation=operation, payload=payload)
        try:
            completed = subprocess.run(
                [str(self.binary), "--json"],
                input=json.dumps(request, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                capture_output=True, timeout=self.timeout, check=True,
            )
            response = json.loads(completed.stdout)
        except (subprocess.SubprocessError, OSError, ValueError) as error:
            raise CQStoreError("FACT_RUST_CALL_FAILED") from error
        require(response.get("request_id") == request_id, "FACT_RUST_RESPONSE_MISMATCH")
        if not response.get("ok"):
            raise CQStoreError(response.get("error", {}).get("code", "FACT_RUST_CALL_FAILED"))
        return response["data"]
