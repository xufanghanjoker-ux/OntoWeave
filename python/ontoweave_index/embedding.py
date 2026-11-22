"""Managed, single-attempt Embedding transport and durable per-input PG cache."""
import json
from hashlib import sha256
from math import hypot, isfinite
import struct
from sys import float_info
from time import perf_counter
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from psycopg import InterfaceError, OperationalError
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from ontoweave_publication.store import digest, ref, require

from .response_evidence import ResponseEvidence, request_id, response_usage

DOCUMENT_PROFILES = {"SOURCE": "retrieval-source/1", "KNOWLEDGE": "retrieval-knowledge/1"}
QUERY_PROFILE = "retrieval-query/1"
MAX_RESPONSE_BYTES = 16_000_000


def embedding_space(*, provider_identity, endpoint_identity, model, dimensions, model_revision=None,
                    configuration_fingerprint, normalization_policy="NONE"):
    body = dict(provider_identity=provider_identity, endpoint_identity=endpoint_identity, model=model,
                model_revision=model_revision, dimensions=dimensions, distance_metric="COSINE",
                normalization_policy=normalization_policy, document_profile_refs=DOCUMENT_PROFILES.copy(),
                compatible_query_profile_ref=QUERY_PROFILE,
                profile_versions={profile: "1" for profile in [*DOCUMENT_PROFILES.values(), QUERY_PROFILE]},
                configuration_fingerprint=configuration_fingerprint)
    return dict(body, space_ref=ref("embedding_space", body))


def validate_space(space):
    body = {k: v for k, v in space.items() if k != "space_ref"}
    profiles = space["document_profile_refs"]
    require(set(profiles) == {"SOURCE", "KNOWLEDGE"} and set(profiles.values())
            | {space["compatible_query_profile_ref"]} == set(space["profile_versions"])
            and type(space["dimensions"]) is int and 0 < space["dimensions"] <= 16000
            and space["distance_metric"] == "COSINE" and space["normalization_policy"] in {"NONE", "L2"}
            and space["space_ref"] == ref("embedding_space", body), "INDEX_EMBEDDING_SPACE_INVALID", 422)


def put_space(q, space):
    validate_space(space)
    key, pin = space["space_ref"], digest(space)
    q("INSERT INTO retrieval_v1.embedding_spaces VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
      [key, Jsonb(space), pin, space["dimensions"]])
    require(q("SELECT body_sha FROM retrieval_v1.embedding_spaces WHERE space_ref=%s", [key]).fetchone()["body_sha"]
            == pin, "INDEX_EMBEDDING_SPACE_CONFLICT", 409)


def get_space(q, space_ref):
    row = q("SELECT body,body_sha FROM retrieval_v1.embedding_spaces WHERE space_ref=%s", [space_ref]).fetchone()
    require(row and digest(row["body"]) == row["body_sha"], "INDEX_EMBEDDING_SPACE_UNAVAILABLE", 503)
    validate_space(row["body"])
    return row["body"]


def validate_vector(vector, space):
    require(isinstance(vector, (list, tuple)) and len(vector) == space["dimensions"]
            and all(type(value) in (float, int) and abs(value) <= float_info.max for value in vector), "INDEX_VECTOR_INVALID", 422)
    norm = hypot(*vector)
    require(norm > 0 and isfinite(norm), "INDEX_VECTOR_INVALID", 422)
    numbers = [value/norm for value in vector] if space["normalization_policy"] == "L2" else vector
    try:
        single = [struct.unpack("!f", struct.pack("!f", value))[0] for value in numbers]
    except (OverflowError, struct.error):
        require(False, "INDEX_VECTOR_INVALID", 422)
    require(any(single) and all(isfinite(value) for value in single), "INDEX_VECTOR_INVALID", 422)
    return single


class EmbeddingTransportError(Exception):
    def __init__(self, code, *, unknown=False, actual_requests=0, receipt=None):
        super().__init__(code)
        self.code = code
        self.unknown = unknown
        self.actual_requests = actual_requests
        self.receipt = receipt or {}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ManagedEmbeddingClient:
    """Uses the configured CQ/production wire protocol with retrieval-specific input profiles."""
    def __init__(self, config, *, credential, transport=None, evidence_directory=None):
        self.protocol, mode = config["protocol"], config["endpoint_mode"]
        require(self.protocol in {"dashscope-native", "openai-compatible"} and mode in {"base", "full"},
                "INDEX_EMBEDDING_PROTOCOL_INVALID", 422)
        url = urlsplit(config["base_url"])
        require(url.scheme == "https" and url.hostname and not (url.username or url.password or url.query or url.fragment),
                "INDEX_EMBEDDING_ENDPOINT_INVALID", 422)
        self.url = config["base_url"].rstrip("/") + ("/embeddings" if mode == "base" else "")
        self.credential = credential
        if not callable(credential):
            self._validate_credential(credential)
        self.max_input_utf8_bytes = config["max_input_utf8_bytes"]
        self.max_batch_utf8_bytes = config["max_batch_utf8_bytes"]
        require(type(self.max_input_utf8_bytes) is int and type(self.max_batch_utf8_bytes) is int
                and self.max_batch_utf8_bytes >= self.max_input_utf8_bytes >= 4, "INDEX_EMBEDDING_LIMIT_INVALID", 422)
        identity = dict(endpoint=self.url, protocol=self.protocol, model=config["model"], dimensions=config["dimensions"],
                        model_revision=config.get("model_revision"), input_profile_wire_version="1")
        self.space = embedding_space(provider_identity=config["provider_identity"],
                                     endpoint_identity=ref("embedding_endpoint", self.url, self.protocol),
                                     model=config["model"], dimensions=config["dimensions"],
                                     model_revision=config.get("model_revision"), configuration_fingerprint=digest(identity))
        validate_space(self.space)
        self.transport = transport
        self.evidence = ResponseEvidence(evidence_directory)

    @staticmethod
    def _validate_credential(value):
        require(isinstance(value, str) and value and not any(char.isspace() for char in value),
                "INDEX_EMBEDDING_CREDENTIAL_REQUIRED", 422)
        return value

    def embed(self, texts, *, library_ref, profile_ref, operation_ref):
        credential = self._validate_credential(self.credential() if callable(self.credential) else self.credential)
        size = [len(text.encode("utf-8")) for text in texts]
        require(0 < len(size) <= 20 and max(size) <= self.max_input_utf8_bytes
                and sum(size) <= self.max_batch_utf8_bytes and profile_ref in self.space["profile_versions"],
                "INDEX_EMBEDDING_INPUT_LIMIT", 422)
        native = self.protocol == "dashscope-native"
        body = dict(model=self.space["model"], input=list(texts))
        if native:
            body["input"] = {"texts": list(texts)}
            body["parameters"] = dict(text_type="query" if profile_ref == QUERY_PROFILE else "document",
                                      dimension=self.space["dimensions"])
        wire = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        started = perf_counter()
        actual_requests = int(self.transport is None)
        raw, http_status, header_id, complete, content_length = None, None, None, False, None
        try:
            if self.transport:
                raw = self.transport(wire)
                http_status = 200
            else:
                request = Request(self.url, data=wire, method="POST", headers={
                    "Content-Type": "application/json", "Authorization": "Bearer " + credential})
                with build_opener(_NoRedirect).open(request, timeout=60) as response:
                    http_status = response.status
                    header_id = response.headers.get("x-request-id")
                    content_length = response.headers.get("Content-Length")
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
            complete = True
        except HTTPError as error:
            http_status = error.code
            header_id = error.headers.get("x-request-id") if error.headers else None
            content_length = error.headers.get("Content-Length") if error.headers else None
            try:
                raw = error.read(MAX_RESPONSE_BYTES + 1)
                complete = True
            except Exception:
                pass
            finally:
                error.close()
        except Exception:
            pass
        if (complete and isinstance(content_length, str) and content_length.isascii() and content_length.isdecimal()
                and len(content_length) <= 20 and len(raw) <= MAX_RESPONSE_BYTES and len(raw) != int(content_length)):
            complete = False
        receive_ms = (perf_counter()-started)*1000
        response = None
        if not complete:
            body_state = "INCOMPLETE" if http_status is not None else "NOT_RECEIVED"
        elif len(raw) > MAX_RESPONSE_BYTES:
            body_state = "RESPONSE_EXCEEDS_CAPTURE_LIMIT"
        else:
            try:
                response = json.loads(raw)
                body_state = "PARSED_JSON"
            except (ValueError, UnicodeError, RecursionError):
                body_state = "UNPARSEABLE"
        usage, usage_status = response_usage(response, credential)
        receipt = dict(request_sha256=digest(body), actual_requests=actual_requests, http_status=http_status,
                       request_id=request_id(response, header_id, credential), usage=usage,
                       usage_status=usage_status, receive_state=body_state, receive_ms=receive_ms,
                       response_sha256=sha256(raw).hexdigest() if complete and len(raw) <= MAX_RESPONSE_BYTES else None,
                       response_bytes=len(raw) if complete and len(raw) <= MAX_RESPONSE_BYTES else None)
        if raw is not None and receipt["response_sha256"] is None:
            receipt.update(captured_prefix_sha256=sha256(raw).hexdigest(), captured_bytes=len(raw))
        retained_at = perf_counter()
        try:
            receipt.update(self.evidence.retain(response, credential=credential, library=library_ref,
                                                operation=operation_ref, metadata=receipt))
        except (OSError, ValueError, TypeError, RecursionError):
            receipt["body_evidence_status"] = "WRITE_FAILED"
        receipt["response_evidence_ms"] = (perf_counter()-retained_at)*1000

        validating = perf_counter()
        if http_status is not None and not 200 <= http_status < 300:
            code = f"PROVIDER_HTTP_{http_status}"
            receipt.update(validation_state="NOT_STARTED", validation_ms=None)
        elif not complete:
            code = "EMBEDDING_OUTCOME_UNKNOWN"
            receipt.update(validation_state="NOT_STARTED", validation_ms=None)
        else:
            code = "EMBEDDING_RESPONSE_INVALID"
            try:
                require(body_state == "PARSED_JSON" and isinstance(response, dict), "INDEX_EMBEDDING_RESPONSE_JSON", 422)
                require(not response.get("code"), "INDEX_EMBEDDING_PROVIDER_ERROR", 422)
                rows = response.get("output") if native else response.get("data")
                if native:
                    require(isinstance(rows, dict), "INDEX_EMBEDDING_RESPONSE_SHAPE", 422)
                    rows = rows.get("embeddings")
                vectors = _response_vectors(rows, native=native, expected=len(texts), space=self.space)
            except Exception as error:
                detail = getattr(error, "code", None) or "INDEX_EMBEDDING_RESPONSE_SHAPE"
                receipt.update(validation_state="FAILED", validation_code=detail)
            else:
                code = None
                receipt.update(validation_state="PASSED")
            receipt["validation_ms"] = (perf_counter()-validating)*1000
        receipt["embedding_ms"] = (perf_counter()-started)*1000
        if code:
            raise EmbeddingTransportError(code, unknown=code == "EMBEDDING_OUTCOME_UNKNOWN",
                                          actual_requests=actual_requests, receipt=receipt)
        return dict(vectors=vectors, receipt=receipt)


def _response_vectors(rows, *, native, expected, space):
    require(isinstance(rows, list) and len(rows) == expected, "INDEX_EMBEDDING_RESPONSE_COUNT", 422)
    indexed = {}
    for row in rows:
        require(isinstance(row, dict), "INDEX_EMBEDDING_RESPONSE_SHAPE", 422)
        keys = [key for key in ("text_index", "index") if key in row] if native else ["index"]
        ordinals = [row.get(key) for key in keys]
        require(ordinals and all(type(value) is int for value in ordinals), "INDEX_EMBEDDING_RESPONSE_INDEX", 422)
        require(len(set(ordinals)) == 1, "INDEX_EMBEDDING_RESPONSE_INDEX_CONFLICT", 422)
        index = ordinals[0]
        require(0 <= index < expected, "INDEX_EMBEDDING_RESPONSE_INDEX_RANGE", 422)
        require(index not in indexed, "INDEX_EMBEDDING_RESPONSE_INDEX_DUPLICATE", 422)
        indexed[index] = validate_vector(row.get("embedding"), space)
    return [indexed[index] for index in range(expected)]


def _cache(q, library, space_ref, profile, shas):
    return {row["text_sha"]: row for row in q("""
       SELECT text_sha,vector_ref,embedding::text AS wire FROM retrieval_v1.embedding_cache
       WHERE library_ref=%s AND space_ref=%s AND profile_ref=%s AND text_sha=ANY(%s)
       """, [library, space_ref, profile, list(shas)]).fetchall()}


def _batches(texts, limit):
    batch, size = [], 0
    for key, text in texts:
        length = len(text.encode("utf-8"))
        if batch and (len(batch) == 20 or size + length > limit):
            yield batch
            batch, size = [], 0
        batch.append((key, text))
        size += length
    if batch:
        yield batch


class EmbeddingCache:
    def __init__(self, store):
        self.store = store

    def resolve(self, library, space, profile, texts, *, client, operation):
        key = space["space_ref"]
        require(profile in space["profile_versions"], "INDEX_EMBEDDING_PROFILE_INVALID", 422)
        require(client is None or client.space == space, "INDEX_EMBEDDING_SPACE_MISMATCH", 422)
        with self.store.transaction() as (q, _):
            put_space(q, space)
            found = _cache(q, library, key, profile, texts)
        existing = len(found)
        failures, receipts = {}, []
        if client is not None:
            require(operation, "INDEX_EMBEDDING_OPERATION_REQUIRED", 422)
            maximum = getattr(client, "max_batch_utf8_bytes", 2**31)
            for batch in _batches(sorted((key, text) for key, text in texts.items() if key not in found), maximum):
                new_rows, receipt = self._dispatch(library, space, profile, batch, client, operation)
                found.update(new_rows)
                if receipt:
                    receipts.append(receipt)
                if receipt and receipt["status"] == "FAILED":
                    failures.update({item: receipt["code"] for item, _ in batch if item not in found})
                    break
        return found, failures, dict(cache_hits=existing, unique_inputs=len(texts), batches=receipts)

    @staticmethod
    def _lock_inputs(q, library, space_ref, profile, keys):
        for item in sorted(keys):
            q("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
              [ref("embedding_cache_lock", library, space_ref, profile, item)])

    def _dispatch(self, library, space, profile, batch, client, operation):
        space_ref = space["space_ref"]
        all_keys = [item for item, _ in batch]
        try:
            with self.store.transaction() as (q, _):
                self._lock_inputs(q, library, space_ref, profile, all_keys)
                existing = _cache(q, library, space_ref, profile, all_keys)
                batch = [(item, text) for item, text in batch if item not in existing]
                if not batch:
                    return existing, None
                keys = [item for item, _ in batch]
                body = dict(space_ref=space_ref, profile_ref=profile, input_sha256=keys)
                batch_ref = ref("embedding_batch", operation, body)
                old = q("""SELECT status,receipt FROM retrieval_v1.embedding_requests
                           WHERE library_ref=%s AND operation_ref=%s""", [library, batch_ref]).fetchone()
                if old and old["status"] == "FAILED":
                    return existing, old["receipt"]
                require(not old, "EMBEDDING_OUTCOME_UNKNOWN", 503)
                q("""INSERT INTO retrieval_v1.embedding_requests
                     (library_ref,operation_ref,request_sha,body,status,receipt) VALUES (%s,%s,%s,%s,'STARTED',NULL)""",
                  [library, batch_ref, digest(body), Jsonb(body)])
                for key in keys:
                    q("INSERT INTO retrieval_v1.embedding_claims VALUES (%s,%s,%s,%s,%s)",
                      [library, space_ref, profile, key, batch_ref])
        except UniqueViolation:
            require(False, "EMBEDDING_IN_FLIGHT_OR_UNKNOWN", 409)
        provider_receipt = {}
        try:
            result = client.embed([text for _, text in batch], library_ref=library,
                                  profile_ref=profile, operation_ref=batch_ref)
            provider_receipt = result["receipt"]
            require(len(result["vectors"]) == len(batch), "INDEX_EMBEDDING_RESPONSE_COVERAGE", 422)
            vectors = [validate_vector(vector, space) for vector in result["vectors"]]
            receipt = dict(provider_receipt, status="RETURNED", operation_ref=batch_ref, input_count=len(batch))
        except Exception as error:
            unknown = not getattr(error, "code", None) or getattr(error, "unknown", False)
            status = "UNKNOWN" if unknown else "FAILED"
            diagnostics = getattr(error, "receipt", None) or provider_receipt
            receipt = dict(diagnostics, status=status, operation_ref=batch_ref, input_count=len(batch),
                           code=getattr(error, "code", None) or "EMBEDDING_OUTCOME_UNKNOWN",
                           actual_requests=diagnostics.get("actual_requests", getattr(error, "actual_requests", None)),
                           usage_status=diagnostics.get("usage_status", "NOT_RETAINED"),
                           save_state="NOT_STARTED", save_ms=None)
            try:
                self._settle(library, batch_ref, receipt, retain_claims=unknown)
            except (OperationalError, InterfaceError):
                require(False, "EMBEDDING_OUTCOME_UNKNOWN", 503, stage="SAVE",
                        provider_outcome=status, operation_ref=batch_ref)
            if unknown:
                require(False, "EMBEDDING_OUTCOME_UNKNOWN", 503)
            return existing, receipt

        saving = perf_counter()
        try:
            if provider_receipt.get("receive_state"):
                with self.store.transaction() as (q, _):
                    checkpoint = dict(receipt, status="STARTED", save_state="COMMIT_UNCONFIRMED", save_ms=None)
                    row = q("""UPDATE retrieval_v1.embedding_requests SET receipt=%s
                               WHERE library_ref=%s AND operation_ref=%s AND status='STARTED' RETURNING status""",
                            [Jsonb(checkpoint), library, batch_ref]).fetchone()
                    require(row, "INDEX_EMBEDDING_SETTLEMENT_CONFLICT", 409)
            with self.store.transaction() as (q, _):
                self._lock_inputs(q, library, space_ref, profile, keys)
                for (key, _), vec in zip(batch, vectors, strict=True):
                    vector_ref = ref("retrieval_vector", library, space["space_ref"], profile, key)
                    q("""INSERT INTO retrieval_v1.embedding_cache VALUES (%s,%s,%s,%s,%s,%s,%s::vector,%s)
                         ON CONFLICT (library_ref,space_ref,profile_ref,text_sha) DO NOTHING""",
                      [library, space["space_ref"], profile, key, vector_ref, len(vec), json.dumps(vec), batch_ref])
                receipt.update(save_state="SAVED", save_ms=(perf_counter()-saving)*1000)
                self._settle(library, batch_ref, receipt, q=q)
                return _cache(q, library, space_ref, profile, all_keys), receipt

        except (OperationalError, InterfaceError):
            require(False, "EMBEDDING_OUTCOME_UNKNOWN", 503, stage="SAVE", operation_ref=batch_ref)

    def _settle(self, library, batch_ref, receipt, *, q=None, retain_claims=False):
        if q is None:
            with self.store.transaction() as (query, _):
                return self._settle(library, batch_ref, receipt, q=query, retain_claims=retain_claims)
        updated = q("""UPDATE retrieval_v1.embedding_requests SET status=%s,receipt=%s
                       WHERE library_ref=%s AND operation_ref=%s AND status='STARTED' RETURNING status""",
                    [receipt["status"], Jsonb(receipt), library, batch_ref]).fetchone()
        require(updated, "INDEX_EMBEDDING_SETTLEMENT_CONFLICT", 409)
        if not retain_claims:
            q("DELETE FROM retrieval_v1.embedding_claims WHERE library_ref=%s AND operation_ref=%s",
              [library, batch_ref])
