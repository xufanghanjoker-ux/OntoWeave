"""Read exact uploaded originals and parsed documents from a confirmed product view."""
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlencode

from ontoweave_cq_similarity.core import digest as record_digest
from ontoweave_publication.readers import _read_view
from ontoweave_publication.store import ref, require


def _confirmed_upload(q, library, view):
    return q("""WITH RECURSIVE lineage AS (
                  SELECT view_revision,parent_view_revision,job_ref,activation_seq
                  FROM publication_v1.manifests WHERE library_ref=%s AND view_revision=%s
                  UNION ALL
                  SELECT m.view_revision,m.parent_view_revision,m.job_ref,m.activation_seq
                  FROM publication_v1.manifests m JOIN lineage l ON m.view_revision=l.parent_view_revision
                  WHERE m.library_ref=%s
                )
                SELECT u.run_ref,b.body FROM lineage l
                JOIN publication_v1.jobs j ON j.library_ref=%s AND j.job_ref=l.job_ref
                JOIN product_upload_v1.uploads u ON u.library_ref=j.library_ref AND u.run_ref=j.request->>'run_ref'
                JOIN publication_v1.builds b ON b.library_ref=u.library_ref AND b.run_ref=u.run_ref
                ORDER BY l.activation_seq DESC LIMIT 1""", [library, view, library, library]).fetchone()


def _parsed(q, run):
    if not q("SELECT to_regclass('front_half.records') AS table_ref").fetchone()["table_ref"]:
        return {}
    result = {}
    rows = q("""SELECT key,payload->>'source_path' AS source_path,
                       payload->'document'->>'doc_id' AS doc_id,payload->'document'->>'revision' AS revision
                FROM front_half.records WHERE run_id=%s AND kind='source'""", [run]).fetchall()
    for row in rows:
        require(row["doc_id"] == row["key"], "DOCUMENT_SOURCE_BINDING_CHANGED", 503)
        path = Path(row["source_path"])
        if path.parts[-4:-2] == (run, "originals") and path.parent.name.isdecimal():
            ordinal = int(path.parent.name)
            require(ordinal not in result, "DOCUMENT_SOURCE_BINDING_AMBIGUOUS", 503)
            result[ordinal] = (path.name, row)
    return result


def _read_parsed(q, run, doc_ref, checksum):
    row = q("""SELECT payload,payload_sha FROM front_half.records
               WHERE run_id=%s AND kind='source' AND key=%s""", [run, doc_ref]).fetchone()
    require(row and record_digest(row["payload"]) == row["payload_sha"], "DOCUMENT_SOURCE_DIGEST_MISMATCH", 503)
    source = row["payload"]
    doc = source["document"]
    require(doc["doc_id"] == doc_ref and doc["revision"] == checksum
            and sha256(bytes.fromhex(source["original_hex"])).hexdigest() == checksum,
            "DOCUMENT_SOURCE_BYTES_CHANGED", 503)
    return doc


def confirmed_documents(q, library, view):
    upload = _confirmed_upload(q, library, view)
    if not upload:
        return []
    run = upload["run_ref"]
    parsed = _parsed(q, run)
    rows = []
    for ordinal, saved in enumerate(upload["body"]["documents"]):
        name = saved["filename"]
        checksum = saved["content_sha256"]
        found = parsed.get(ordinal)
        doc = None
        if found:
            saved_name, doc = found
            require(saved_name == name and doc["revision"] == checksum, "DOCUMENT_SOURCE_BINDING_CHANGED", 503)
            require(not saved.get("doc_ref") or saved["doc_ref"] == doc["doc_id"], "DOCUMENT_SOURCE_BINDING_CHANGED", 503)
        document_rev = saved.get("document_revision_ref") or ref("document_revision", saved["document_ref"], checksum, name)
        source = ref("document_source", library, doc["doc_id"], checksum) if doc else None
        public = dict(saved, document_revision_ref=document_rev, view_revision=view, source_ref=source,
                      doc_ref=doc["doc_id"] if doc else saved.get("doc_ref"),
                      download_url=f"/api/v1/libraries/{library}/documents/{document_rev}/original?" +
                                   urlencode({"view_revision": view}))
        rows.append((public, run if doc else None, saved.get("original_run_ref", run), saved.get("original_ordinal", ordinal)))
    return rows


class DocumentReader:
    def __init__(self, store):
        self.store = store

    def original(self, library, document_revision, view_revision):
        with self.store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library, view_revision)["view_revision"]
            selected = next((row for row in confirmed_documents(q, library, view)
                             if row[0]["document_revision_ref"] == document_revision), None)
            require(selected, "DOCUMENT_VERSION_NOT_FOUND", 404)
            document, _, run, ordinal = selected
            stored = q("""SELECT d.payload FROM product_upload_v1.documents d
                          JOIN product_upload_v1.uploads u USING(run_ref)
                          WHERE u.library_ref=%s AND d.run_ref=%s AND d.ordinal=%s""",
                       [library, run, ordinal]).fetchone()
            require(stored and sha256(stored["payload"]).hexdigest() == document["content_sha256"],
                    "DOCUMENT_ORIGINAL_DIGEST_MISMATCH", 503)
            return document, stored["payload"]

    def source(self, library, source_ref, view_revision):
        with self.store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library, view_revision)["view_revision"]
            for entry, parsed_run, _, _ in confirmed_documents(q, library, view):
                if entry["source_ref"] == source_ref:
                    doc = _read_parsed(q, parsed_run, entry["doc_ref"], entry["content_sha256"])
                    return dict(entry, title=entry["filename"], text=doc["content"], precision="PARSED_DOCUMENT",
                                location=dict(doc_ref=entry["doc_ref"], revision=entry["content_sha256"]))
            require(False, "SOURCE_NOT_FOUND", 404)
