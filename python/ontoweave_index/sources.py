"""Source inventories come from authenticated parse output, independent of graph citations."""
from hashlib import sha256

from psycopg.types.json import Jsonb

from ontoweave_cq_similarity.core import digest as record_digest
from ontoweave_publication.store import digest, ref, require

from .material import text_sha


def register(q, library, manifest_ref, blocks, authority):
    require(isinstance(authority, dict) and authority.get("kind"), "INDEX_SOURCE_AUTHORITY_REQUIRED", 422)
    normalized = {}
    for block in blocks:
        key = block["source_ref"]
        require(key and key not in normalized and all(block.get(field) for field in
                ("doc_ref", "document_revision", "parent_block_ref", "precision")), "INDEX_SOURCE_BLOCK_INVALID", 422)
        text = block["text"]
        require(text is None or isinstance(text, str), "INDEX_SOURCE_TEXT_INVALID", 422)
        expected = text_sha(text) if text is not None else None
        require(block.get("text_sha256") in (expected, None), "INDEX_SOURCE_BYTES_CHANGED", 422)
        normalized[key] = dict(block, text_sha256=expected)
    body = dict(authority=authority, blocks=[normalized[key] for key in sorted(normalized)])
    pin = digest(body)
    q("INSERT INTO retrieval_v1.source_manifests VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
      [library, manifest_ref, Jsonb(body), pin])
    require(read(q, library, manifest_ref)["body_sha"] == pin, "INDEX_SOURCE_MANIFEST_CONFLICT", 409)
    return pin


def read(q, library, manifest_ref):
    row = q("""SELECT body,body_sha FROM retrieval_v1.source_manifests
               WHERE library_ref=%s AND source_manifest_ref=%s""", [library, manifest_ref]).fetchone()
    require(row, "INDEX_SOURCE_MANIFEST_UNAVAILABLE", 422, source_manifest_ref=manifest_ref)
    require(digest(row["body"]) == row["body_sha"], "INDEX_SOURCE_MANIFEST_DIGEST_MISMATCH", 503)
    return row


def _frozen_record(q, run_ref, kind, key):
    row = q("""SELECT payload,payload_sha FROM front_half.records
               WHERE run_id=%s AND kind=%s AND key=%s""", [run_ref, kind, key]).fetchone()
    require(row and record_digest(row["payload"]) == row["payload_sha"],
            "INDEX_SAVED_SOURCE_RECORD_UNAVAILABLE", 422, kind=kind)
    return row


def read_saved(q, library, run_ref):
    require(q("SELECT to_regclass('front_half.records') AS records").fetchone()["records"],
            "INDEX_SAVED_SOURCE_RECORD_UNAVAILABLE", 422)
    build = _frozen_record(q, run_ref, "front_half", run_ref)["payload"]
    snapshot = _frozen_record(q, run_ref, "snapshot", run_ref)
    plan = _frozen_record(q, run_ref, "source_plan", run_ref)
    parsed, chunked = snapshot["payload"], plan["payload"]
    require(build["workspace"] == parsed["library_id"] == library and build["run_id"] == run_ref
            and build["status"] in {"COMPLETED", "PARTIAL"}
            and chunked["source_snapshot_ref"] == parsed["snapshot_id"]
            and chunked["source_fingerprint"] == parsed["fingerprint"]
            and {(d["doc_id"], d["revision"]) for d in parsed["documents"]}
            == {(d["doc_ref"], d["revision"]) for d in chunked["documents"]},
            "INDEX_SAVED_SOURCE_BASIS_MISMATCH", 422)
    blocks = []
    for doc in parsed["documents"]:
        saved = _frozen_record(q, run_ref, "source", doc["doc_id"])["payload"]
        require(saved["document"] == doc and saved["docling"]["blocks"] == doc["blocks"]
                and sha256(bytes.fromhex(saved["original_hex"])).hexdigest() == doc["revision"],
                "INDEX_SAVED_DOCUMENT_BASIS_MISMATCH", 422, doc_ref=doc["doc_id"])
        for block in doc["blocks"]:
            key = block["block_id"]
            item = dict(source_ref=ref("parsed_source", doc["doc_id"], doc["revision"], key),
                        doc_ref=doc["doc_id"], document_revision=doc["revision"], parent_block_ref=key,
                        unit_ref=key, text=block.get("text"), precision="PARSED_BLOCK", title=doc.get("title"))
            if not item["text"] or not item["text"].strip():
                item["gap"] = "PARSED_BLOCK_NO_READABLE_TEXT"
            blocks.append(item)
    return blocks, dict(kind="SAVED_FRONT_HALF", run_ref=run_ref, snapshot_ref=parsed["snapshot_id"],
                        snapshot_sha256=snapshot["payload_sha"], source_plan_sha256=plan["payload_sha"])
