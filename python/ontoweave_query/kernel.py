"""Adapter for the existing deterministic native-query Rust kernel."""
import json
from hashlib import sha256
from pathlib import Path
import subprocess
from uuid import uuid4

VERSION = "lightog-native-query-core/1"


class QueryError(Exception):
    def __init__(self, code, *, recoverable=False):
        super().__init__(code)
        self.code = code
        self.recoverable = recoverable


class QueryKernel:
    def __init__(self, binary, expected_sha256):
        self.binary = Path(binary).resolve(strict=True)
        self.expected_sha256 = expected_sha256
        self._signature = None
        self._verify()

    def _verify(self):
        stat = self.binary.stat()
        signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_ctime_ns, stat.st_mtime_ns)
        if signature != self._signature:
            if sha256(self.binary.read_bytes()).hexdigest() != self.expected_sha256:
                raise QueryError("QUERY_KERNEL_DIGEST_MISMATCH")
            self._signature = signature

    def __call__(self, operation, payload):
        self._verify()
        request_id = uuid4().hex
        wire = json.dumps(dict(wire_version="lightog-core/0.1", request_id=request_id,
                               module="native_query_v1", operation=operation,
                               payload=dict(contract_version=VERSION, input=payload)),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(wire) > 64 * 1024 * 1024:
            raise QueryError("QUERY_KERNEL_REQUEST_TOO_LARGE")
        try:
            result = subprocess.run([str(self.binary), "--json"], input=wire,
                                    capture_output=True, check=True, timeout=60)
            response = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise QueryError("QUERY_KERNEL_EXECUTION_FAILED") from exc
        if response.get("request_id") != request_id:
            raise QueryError("QUERY_KERNEL_RESPONSE_MISMATCH")
        if response.get("ok") is not True:
            raise QueryError(response.get("error", {}).get("code", "QUERY_KERNEL_EXECUTION_FAILED"))
        data = response["data"]
        if data.get("operation") != operation or data.get("contract_version") != VERSION:
            raise QueryError("QUERY_KERNEL_RESPONSE_MISMATCH")
        return data["result"]
