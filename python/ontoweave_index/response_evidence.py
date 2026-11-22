"""Private, credential-redacted Embedding response evidence."""
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from tempfile import mkdtemp
from math import isfinite

_SECRET_KEYS = {"authorization", "proxyauthorization", "apikey", "credential", "password",
                "token", "accesstoken", "refreshtoken", "secret", "clientsecret", "accesskey", "xapikey", "xauthtoken"}
_BEARER = re.compile(r"\bBearer[ \t]+[A-Za-z0-9._~+/=\-]+", re.IGNORECASE)
_REQUEST_ID = re.compile(r"[A-Za-z0-9_.:/\-]{1,256}\Z")
_USAGE_KEY = re.compile(r"(?:[A-Za-z0-9_]+_tokens|tokens|input_count|output_count)\Z")


def _redact_text(text, credential):
    return _BEARER.sub("Bearer [REDACTED]", text.replace(credential, "[REDACTED]"))


def _redact(value, credential):
    if isinstance(value, str):
        return _redact_text(value, credential)
    if isinstance(value, list):
        return [_redact(item, credential) for item in value]
    if isinstance(value, dict):
        return {_redact_text(key, credential): (
            "[REDACTED]" if re.sub(r"[^a-z0-9]", "", key.lower()) in _SECRET_KEYS else _redact(item, credential)
        ) for key, item in value.items()}
    return value


def request_id(response, header_request_id, credential):
    payload = response if isinstance(response, dict) else {}
    for token in (payload.get("request_id"), payload.get("id"), header_request_id):
        if isinstance(token, str) and credential not in token and _REQUEST_ID.fullmatch(token):
            return token
    return None


def response_usage(response, credential):
    if not isinstance(response, dict):
        return None, "UNREADABLE"
    data = response.get("usage")
    if data is None:
        return None, "NOT_PROVIDED"
    if not isinstance(data, dict):
        return None, "UNREADABLE"

    def numeric(fields):
        result = {}
        for key, item in fields.items():
            if credential in key:
                continue
            if isinstance(item, dict) and re.fullmatch(r"[A-Za-z0-9_]+_tokens_details", key):
                values = numeric(item)
                if values:
                    result[key] = values
            elif (_USAGE_KEY.fullmatch(key) and type(item) in (int, float)
                  and 0 <= item <= 2**63-1 and isfinite(item)):
                result[key] = item
        return result

    try:
        usage = numeric(data)
    except RecursionError:
        return None, "UNREADABLE"
    return (usage, "PROVIDED") if usage else (None, "UNREADABLE")


class ResponseEvidence:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory is not None else Path(mkdtemp(prefix="ontoweave-embedding-evidence-"))
        if not self.directory.is_absolute():
            raise ValueError("INDEX_RESPONSE_EVIDENCE_DIRECTORY_INVALID")
        self.directory.mkdir(mode=0o700, exist_ok=True)
        fd = self._open_directory()
        os.close(fd)

    def _open_directory(self):
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            os.close(fd)
            raise OSError("INDEX_RESPONSE_EVIDENCE_DIRECTORY_NOT_PRIVATE")
        return fd

    def retain(self, response, *, credential, library, operation, metadata):
        """Save sanitized JSON and metadata together before business validation."""
        path = sha256(json.dumps([library, operation], ensure_ascii=True).encode()).hexdigest() + ".json"
        retained = json.dumps(_redact(response, credential), ensure_ascii=True, separators=(",", ":")).encode()
        retained_sha = sha256(retained).hexdigest()
        directory = self._open_directory()
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(descriptor, "wb") as output:
                output.write(b'{"receipt":')
                output.write(json.dumps(metadata, ensure_ascii=True, allow_nan=False).encode())
                output.write(b',"response":')
                output.write(retained)
                output.write(b"}\n")
                output.flush()
                os.fsync(output.fileno())
            os.fsync(directory)
        finally:
            os.close(directory)
        return dict(body_evidence_status="RETAINED" if response is not None else "METADATA_ONLY",
                    response_evidence_path=str(self.directory / path), retained_response_sha256=retained_sha)
