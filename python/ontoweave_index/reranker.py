"""Optional configured re-ranking of the shared query owner's bounded candidates."""
import json
from math import isfinite
from time import perf_counter
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from urllib.error import HTTPError

from psycopg.types.json import Jsonb

from ontoweave_publication.store import digest, require

from .embedding import MAX_RESPONSE_BYTES, _NoRedirect
from .material import text_sha


class ManagedReranker:
    def __init__(self, store, library, config, *, credential, transport=None):
        self.store, self.library = store, library
        self.model = config["model"]
        self.protocol, mode = config["protocol"], config["endpoint_mode"]
        provider = config["provider_identity"]
        url = urlsplit(config["base_url"])
        require(provider and self.model and credential and self.protocol in {"dashscope-native", "openai-compatible"}
                and mode in {"base", "full"} and url.scheme == "https" and url.hostname
                and not (url.username or url.password or url.query or url.fragment), "QUERY_RERANK_CONFIG_INVALID", 422)
        self.url = config["base_url"].rstrip("/") + ("/rerank" if mode == "base" else "")
        self.binding = digest([provider, self.url, self.protocol, self.model, config.get("model_revision")])
        self.credential, self.transport = credential, transport

    def __call__(self, query, documents, *, operation_ref):
        require(isinstance(query, str) and query.strip() and type(documents) is list and 0 < len(documents) <= 64
                and all(isinstance(text, str) and text.strip() for text in documents) and operation_ref,
                "QUERY_RERANK_INPUT_INVALID", 422)
        native = self.protocol == "dashscope-native"
        body = dict(model=self.model, input=dict(query=query, documents=documents),
                    parameters=dict(top_n=len(documents), return_documents=False)) if native else dict(
                    model=self.model, query=query, documents=documents, return_documents=False)
        wire = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        request = dict(binding_sha256=self.binding, model=self.model, wire_sha256=text_sha(wire.decode()),
                       query_sha256=text_sha(query), input_sha256=[text_sha(text) for text in documents])
        pin = digest(request)
        with self.store.transaction() as (q, _):
            inserted = q("""
              INSERT INTO retrieval_v1.rerank_requests (library_ref,operation_ref,request_sha,body,status)
              VALUES (%s,%s,%s,%s,'STARTED') ON CONFLICT DO NOTHING RETURNING status
              """, [self.library, operation_ref, pin, Jsonb(request)]).fetchone()
            if not inserted:
                old = q("""SELECT request_sha,status,receipt FROM retrieval_v1.rerank_requests
                           WHERE library_ref=%s AND operation_ref=%s""", [self.library, operation_ref]).fetchone()
                require(old["request_sha"] == pin, "QUERY_RERANK_OPERATION_CONFLICT", 409)
                require(old["status"] not in {"STARTED", "UNKNOWN"}, "QUERY_RERANK_OUTCOME_UNKNOWN", 503)
                if old["status"] != "RETURNED":
                    require(False, old["receipt"]["code"], 503)
                return old["receipt"]["order"]

        start = perf_counter()
        received, usage = False, None
        try:
            if self.transport:
                raw = self.transport(wire)
            else:
                payload = Request(self.url, data=wire, method="POST",
                                  headers={"Content-Type":"application/json", "Authorization":"Bearer "+self.credential})
                with build_opener(_NoRedirect).open(payload, timeout=60) as response:
                    raw = response.read(MAX_RESPONSE_BYTES+1)
            received = True
            require(len(raw) <= MAX_RESPONSE_BYTES, "QUERY_RERANK_RESPONSE_INVALID", 503)
            value = json.loads(raw)
            rows = value["output"]["results"] if native else value["results"]
            require(sorted(row["index"] for row in rows) == list(range(len(documents)))
                    and all(type(row["index"]) is int and type(row["relevance_score"]) in (int,float)
                            and isfinite(row["relevance_score"]) for row in rows) and not value.get("code"),
                    "QUERY_RERANK_RESPONSE_INVALID", 503)
            order = [row["index"] for row in sorted(rows, key=lambda row:(-row["relevance_score"], row["index"]))]
            usage = {name: count for name, count in (value.get("usage") or {}).items()
                     if type(count) in (int, float) and isfinite(count) and count >= 0}
        except HTTPError as error:
            error.close()
            return self._failed(operation_ref, start, "FAILED", f"QUERY_RERANK_HTTP_{error.code}")
        except Exception:
            return self._failed(operation_ref, start, "FAILED" if received else "UNKNOWN",
                                "QUERY_RERANK_RESPONSE_INVALID" if received else "QUERY_RERANK_OUTCOME_UNKNOWN")
        self._settle(operation_ref, "RETURNED",
                     dict(order=order, usage=usage or None, elapsed_ms=(perf_counter()-start)*1000,
                          actual_requests=int(self.transport is None), response_sha256=text_sha(raw.decode())))
        return order

    def _failed(self, operation, start, status, code):
        self._settle(operation, status, dict(code=code, elapsed_ms=(perf_counter()-start)*1000,
                                               actual_requests=int(self.transport is None)))
        require(False, code, 503)

    def _settle(self, operation, status, receipt):
        with self.store.transaction() as (q, _):
            row = q("""UPDATE retrieval_v1.rerank_requests SET status=%s,receipt=%s
                       WHERE library_ref=%s AND operation_ref=%s AND status='STARTED' RETURNING status""",
                    [status, Jsonb(receipt), self.library, operation]).fetchone()
            require(row, "QUERY_RERANK_SETTLEMENT_CONFLICT", 409)
