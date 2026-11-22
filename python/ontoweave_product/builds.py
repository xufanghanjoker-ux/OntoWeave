"""Atomic upload admission and authoritative, reconnectable build progress."""

from hashlib import sha256
from pathlib import Path

from psycopg.types.json import Jsonb

from ontoweave_api.builds import BuildPort
from ontoweave_publication.readers import Reader, _publication_status
from ontoweave_publication.store import ROOT, assert_base, assert_workspace_writable, digest, event, head, manifest, ref, require
from .capabilities import workspace_capabilities
from .documents import DocumentReader, confirmed_documents
from .models import hold_model_configuration

MAX_FILES = 8
MAX_BYTES = 20 * 1024 * 1024
SUFFIXES = {".md", ".docx", ".pdf"}
TERMINAL = {"COMPLETED", "PARTIAL", "FAILED", "UNKNOWN_HOLD"}
UPLOAD_LIMITS = dict(max_files=MAX_FILES, max_total_bytes=MAX_BYTES, suffixes=sorted(SUFFIXES))


def migrate_upload(store):
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-publication-schema'))")
        for version, filename in ((11, "011-product-upload-v1.sql"), (15, "015-product-source-snapshots-v1.sql"),
                                  (16, "016-product-identity-source-scope-v1.sql")):
            data = (ROOT / "migrations" / filename).read_bytes()
            checksum = sha256(data).hexdigest()
            saved = q("SELECT sha256 FROM publication_schema_migrations WHERE version=%s", [version]).fetchone()
            if saved:
                require(saved["sha256"] == checksum, "PRODUCT_UPLOAD_MIGRATION_CHANGED")
            else:
                q(data.decode())
                q("INSERT INTO publication_schema_migrations VALUES(%s,%s)", [version, checksum])


def _documents(files, run):
    require(0 < len(files) <= MAX_FILES, "UPLOAD_FILE_COUNT_INVALID", 422, maximum=MAX_FILES)
    inputs, remaining = [], MAX_BYTES
    for file in files:
        name = file.filename or ""
        require(0 < len(name.encode()) <= 240 and name not in {".", ".."}
                and "/" not in name and "\\" not in name and not any(ord(c) < 32 for c in name),
                "UPLOAD_NAME_INVALID", 422)
        require(Path(name).suffix.lower() in SUFFIXES, "UPLOAD_FORMAT_UNSUPPORTED", 422, filename=name)
        data = file.file.read(remaining + 1)
        require(bool(data), "UPLOAD_FILE_SIZE_INVALID", 422, maximum=MAX_BYTES, filename=name)
        require(len(data) <= remaining, "UPLOAD_TOTAL_SIZE_INVALID", 422, maximum=MAX_BYTES)
        remaining -= len(data)
        inputs.append((name, sha256(data).hexdigest(), data))
    inputs.sort(key=lambda row: row[:2])
    documents = [dict(filename=name, title=name, content_sha256=checksum, bytes=len(data), status="ACCEPTED",
                      document_ref=ref("upload_doc", run, ordinal, name, checksum))
                 for ordinal, (name, checksum, data) in enumerate(inputs)]
    return documents, [row[2] for row in inputs]


def _load(q, library, run):
    return q("SELECT body FROM publication_v1.builds WHERE library_ref=%s AND run_ref=%s",
             [library, run]).fetchone()


def _timestamp(q):
    return q("SELECT clock_timestamp() AS stamp").fetchone()["stamp"].isoformat()


class ProductBuilds(BuildPort):
    worker_available = staticmethod(lambda: True)
    managed_models = False

    def receive(self, library, actor, files, operation, *, action="APPEND", base=None, document_ref=None):
        require(isinstance(operation, str) and 0 < len(operation) <= 200
                and not any(c.isspace() or ord(c) < 32 for c in operation), "UPLOAD_OPERATION_REQUIRED", 422)
        require((action == "APPEND" and files and not document_ref)
                or (action == "REPLACE" and len(files) == 1 and document_ref and base)
                or (action == "REMOVE" and not files and document_ref and base),
                "DOCUMENT_OPERATION_INPUT_INVALID", 422)
        run = ref("product_build", library, actor, operation)
        incoming, originals = _documents(files, run) if files else ([], [])
        fingerprint = digest([action, base, document_ref, [(row["filename"], row["content_sha256"]) for row in incoming]])
        with self.store.transaction() as (q, _):
            if self.managed_models:
                hold_model_configuration(q)
            state = head(q, library, lock=True)
            previous = q("""SELECT u.input_sha256,b.body FROM product_upload_v1.uploads u
                            JOIN publication_v1.builds b USING(library_ref,run_ref)
                            WHERE u.library_ref=%s AND u.actor_ref=%s AND u.operation_ref=%s""",
                         [library, actor, operation]).fetchone()
            if previous:
                same = fingerprint if "upload_operation" in previous["body"] else digest(incoming)
                require(previous["input_sha256"] == same and
                        ("upload_operation" in previous["body"] or (action == "APPEND" and base is None)),
                        "UPLOAD_OPERATION_CONFLICT")
                return self._read(q, library, run, state["active_view_revision"])
            assert_workspace_writable(self.store, q, library)
            assert_base(state, base)
            require(self.worker_available(), "PRODUCT_BUILD_WORKER_UNAVAILABLE", 503)
            unsettled = q("""SELECT EXISTS (
                SELECT 1 FROM publication_v1.builds WHERE library_ref=%s
                AND body->>'execution_status' IN ('QUEUED','RUNNING','UNKNOWN_HOLD')
                UNION ALL SELECT 1 FROM publication_v1.jobs WHERE library_ref=%s
                AND status IN ('QUEUED','RUNNING','UNKNOWN_HOLD')
                ) AS busy""", [library, library]).fetchone()["busy"]
            pending_identity = q("SELECT pending_revision FROM identity_v1.libraries WHERE library_ref=%s",
                                 [library]).fetchone()
            require(not unsettled and not (pending_identity or {}).get("pending_revision"), "DOCUMENT_BUILD_UNSETTLED")
            saved = confirmed_documents(q, library, base) if base else []
            require(not base or saved or self._is_product_view(q, library, base), "DOCUMENT_SNAPSHOT_UNAVAILABLE", 409)
            documents = []
            target = None
            for row, _, original_run, original_ordinal in saved:
                prior = self._snapshot_row(row, original_run, original_ordinal)
                if row["document_ref"] == document_ref:
                    target = prior
                else:
                    documents.append(prior)
            require(action == "APPEND" or target, "DOCUMENT_NOT_FOUND", 404)
            for ordinal, row in enumerate(incoming):
                if target:
                    require(row["content_sha256"] != target["content_sha256"] or row["filename"] != target["filename"],
                            "DOCUMENT_REVISION_UNCHANGED", 422)
                    row.update(document_ref=target["document_ref"], doc_ref=target["doc_ref"])
                else:
                    row["doc_ref"] = row["document_ref"]
                row["document_revision_ref"] = ref("document_revision", row["document_ref"], row["content_sha256"], row["filename"])
                documents.append(self._snapshot_row(row, run, ordinal))
            require(len(documents) <= MAX_FILES, "DOCUMENT_SNAPSHOT_FILE_LIMIT", 422, maximum=MAX_FILES)
            require(sum(row["bytes"] for row in documents) <= MAX_BYTES,
                    "DOCUMENT_SNAPSHOT_SIZE_LIMIT", 422, maximum=MAX_BYTES)
            stamp = _timestamp(q)
            reception = dict(stage="RECEPTION", status="COMPLETED", started_at=stamp, ended_at=stamp,
                             updated_at=stamp, counts={"documents": len(documents), "bytes": sum(d["bytes"] for d in documents)},
                             usage=_no_usage(), artifacts=[d["document_revision_ref"] for d in documents], gaps=[])
            source_snapshot = ref("product_source_snapshot", library, [row["document_revision_ref"] for row in documents])
            body = dict(run_ref=run, execution_status="QUEUED", documents=documents, stages=[reception],
                        base_view_revision=base, source_snapshot_ref=source_snapshot, upload_operation=action,
                        gaps=[], available_actions=[], next_action=None, accepted_at=stamp)
            q("INSERT INTO publication_v1.builds VALUES(%s,%s,%s)", [library, run, Jsonb(body)])
            q("""INSERT INTO product_upload_v1.uploads(library_ref,run_ref,actor_ref,operation_ref,input_sha256)
                 VALUES(%s,%s,%s,%s,%s)""", [library, run, actor, operation, fingerprint])
            for ordinal, data in enumerate(originals):
                q("INSERT INTO product_upload_v1.documents VALUES(%s,%s,%s)", [run, ordinal, data])
            event(q, library, "build.stage_changed", dict(reception, execution_status="QUEUED"), run=run)
            return dict(body, library_ref=library, publication_status="NONE", active_view_revision=base)

    @staticmethod
    def _is_product_view(q, library, base):
        from .documents import _confirmed_upload

        return _confirmed_upload(q, library, base) is not None

    @staticmethod
    def _snapshot_row(row, origin, ordinal):
        fields = ("filename", "title", "content_sha256", "bytes", "status", "document_ref", "document_revision_ref")
        return {**{key: row[key] for key in fields}, "doc_ref": row.get("doc_ref") or row["document_ref"],
                "original_run_ref": origin, "original_ordinal": ordinal}

    def basis(self, library, run):
        with self.store.transaction(readonly=True) as (q, _):
            body = _load(q, library, run)["body"]
            state = head(q, library)
            base = body.get("base_view_revision")
            assert_base(state, base)
            adopted = manifest(q, library, base) if base else None
            prior = confirmed_documents(q, library, base) if base else []
            documents = [(d.get("doc_ref"), d["content_sha256"]) for d in body["documents"]]
            snapshot = body.get("source_snapshot_ref")
            if snapshot is not None:
                require(snapshot == ref("product_source_snapshot", library,
                                        [d["document_revision_ref"] for d in body["documents"]]),
                        "PRODUCT_SOURCE_SNAPSHOT_CHANGED")
            return adopted, snapshot, documents, [
                (row["doc_ref"], row["content_sha256"]) for row, _, _, _ in prior]

    def _read(self, q, library, run, active):
        saved = _load(q, library, run)
        require(saved, "BUILD_NOT_FOUND", 404)
        body = saved["body"]
        job = q("""SELECT job_ref,status,target_view_revision,failure FROM publication_v1.jobs
                   WHERE library_ref=%s AND request->>'run_ref'=%s ORDER BY created_at DESC LIMIT 1""",
                [library, run]).fetchone()
        stage = next((item for item in body["stages"] if item["stage"] == "PUBLICATION"), None)
        publishing = {"RUNNING": "PREPARING", "FAILED": "FAILED", "UNKNOWN_HOLD": "UNKNOWN_HOLD"}
        return dict(body, library_ref=library, active_view_revision=active,
                    publication_status=_publication_status(job["status"]) if job else publishing.get((stage or {}).get("status"), "NONE"),
                    job_ref=job["job_ref"] if job else None, failure=job["failure"] if job else body.get("failure"),
                    view_revision=job["target_view_revision"] if job and job["status"] == "SUCCEEDED" else None)

    def read(self, library, run):
        with self.store.transaction(readonly=True) as (q, _):
            head_row = head(q, library)
            require(q("SELECT 1 FROM product_upload_v1.uploads WHERE library_ref=%s AND run_ref=%s", [library, run]).fetchone(),
                    "BUILD_NOT_FOUND", 404)
            return self._read(q, library, run, head_row["active_view_revision"])

    def claim(self, libraries):
        with self.store.transaction() as (q, _):
            upload = q("""SELECT u.library_ref,u.run_ref FROM product_upload_v1.uploads u
                          JOIN publication_v1.builds b USING(library_ref,run_ref)
                          WHERE u.library_ref=ANY(%s) AND b.body->>'execution_status'='QUEUED'
                          ORDER BY u.accepted_at,u.run_ref LIMIT 1 FOR UPDATE OF u SKIP LOCKED""", [libraries]).fetchone()
            if upload:
                self._stage(q, upload["library_ref"], upload["run_ref"], "PARSING", "RUNNING")
            return upload

    def sources(self, library, run, output):
        with self.store.transaction(readonly=True) as (q, _):
            body = _load(q, library, run)["body"]
            files = []
            for ordinal, document in enumerate(body["documents"]):
                pointer = [document.get("original_run_ref", run), document.get("original_ordinal", ordinal)]
                row = q("""SELECT d.payload FROM product_upload_v1.documents d
                           JOIN product_upload_v1.uploads u USING(run_ref)
                           WHERE u.library_ref=%s AND d.run_ref=%s AND d.ordinal=%s""", [library, *pointer]).fetchone()
                require(row and sha256(row["payload"]).hexdigest() == document["content_sha256"], "UPLOAD_SOURCE_BYTES_CHANGED")
                folder = output / "originals" / str(ordinal)
                folder.mkdir(parents=True, mode=0o700)
                destination = folder / document["filename"]
                with destination.open("xb") as stream:
                    stream.write(row["payload"])
                files.append(destination)
            return files

    def stage(self, library, run, stage, status, counts=None, *, usage=None, artifacts=(), gaps=(), execution_status="RUNNING"):
        with self.store.transaction() as (q, _):
            return self._stage(q, library, run, stage, status, counts, usage=usage, artifacts=artifacts,
                               gaps=gaps, execution_status=execution_status)

    def _stage(self, q, library, run, stage, status, counts=None, *, usage=None, artifacts=(), gaps=(),
               execution_status="RUNNING"):
        head(q, library, lock=True)
        body = _load(q, library, run)["body"]
        require(body["execution_status"] not in TERMINAL, "PRODUCT_BUILD_ALREADY_SETTLED")
        stages = {entry["stage"]: entry for entry in body["stages"]}
        stamp = _timestamp(q)
        entry = dict(stages.get(stage, {}), stage=stage, status=status, updated_at=stamp,
                     counts=counts or {}, usage=usage or _no_usage(), artifacts=list(artifacts), gaps=list(gaps))
        entry.setdefault("started_at", stamp)
        if status != "RUNNING":
            entry["ended_at"] = stamp
        stages[stage] = entry
        all_gaps = {digest(gap): gap for item in stages.values() for gap in item["gaps"]}
        body.update(stages=list(stages.values()), execution_status=execution_status, gaps=list(all_gaps.values()))
        if execution_status in TERMINAL:
            body["ended_at"] = stamp
        q("UPDATE publication_v1.builds SET body=%s WHERE library_ref=%s AND run_ref=%s", [Jsonb(body), library, run])
        stopped = execution_status in {"FAILED", "UNKNOWN_HOLD"}
        event(q, library, "build.stopped" if stopped else "build.stage_changed",
              dict(entry, execution_status=execution_status, gaps=body["gaps"]), run=run)

    def progress(self, library, run, stage, counts):
        with self.store.transaction() as (q, _):
            head(q, library, lock=True)
            body = _load(q, library, run)["body"]
            if body["execution_status"] != "RUNNING" or not body["stages"]:
                return
            entry = body["stages"][-1]
            if entry["stage"] != stage or entry["status"] != "RUNNING":
                return
            merged = {**entry["counts"], **counts}
            if merged == entry["counts"]:
                return
            entry.update(counts=merged, updated_at=_timestamp(q))
            q("UPDATE publication_v1.builds SET body=%s WHERE library_ref=%s AND run_ref=%s", [Jsonb(body),library,run])
            event(q, library, "build.progress", dict(entry, execution_status="RUNNING"), run=run)

    def settle_interrupted(self, libraries):
        with self.store.transaction(readonly=True) as (q, _):
            rows = q("""SELECT u.library_ref,u.run_ref,b.body FROM product_upload_v1.uploads u
                        JOIN publication_v1.builds b USING(library_ref,run_ref)
                        WHERE u.library_ref=ANY(%s) AND b.body->>'execution_status'='RUNNING'""",
                     [libraries]).fetchall()
        for row in rows:
            library, run = row["library_ref"], row["run_ref"]
            if not self.settle_confirmed(library, run):
                stage = row["body"]["stages"][-1]
                gaps = [*stage["gaps"], {"reason_code": "WORKER_INTERRUPTED", "scope_ref": run}]
                self.stage(library, run, stage["stage"], "UNKNOWN_HOLD", stage["counts"], usage=_unknown_usage(),
                           artifacts=stage["artifacts"], gaps=gaps, execution_status="UNKNOWN_HOLD")

    def settle_confirmed(self, library, run):
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            job = q("""SELECT job_ref,request,target_view_revision FROM publication_v1.jobs
                       WHERE library_ref=%s AND status='SUCCEEDED' AND request->>'run_ref'=%s""", [library, run]).fetchone()
            if not job:
                return False
            view = manifest(q, library, job["target_view_revision"])
            require(view["view_revision"] == state["active_view_revision"], "PRODUCT_PUBLICATION_HEAD_MISMATCH")
            status = job["request"]["execution_status"]
            self._stage(q, library, run, "PUBLICATION", "COMPLETED",
                        {"processed": 1, "total": 1, "unit_label": "个已确认视图"},
                        artifacts=[job["job_ref"], view["view_revision"], view["graph_revision"], view["index_revision"]],
                        gaps=view["gaps"], execution_status=status)
            return True


class ProductReader(Reader):
    def __init__(self, store, builds, mode, *, query_registered=False, creation_registered=False, models=None, **kwargs):
        super().__init__(store, query_registered=query_registered, models=models, **kwargs)
        self.builds = builds
        self.mode = mode
        self.creation_registered = creation_registered
        self.documents = DocumentReader(store)

    def _capabilities(self, adopted):
        value = super()._capabilities(adopted)
        settings = getattr(self.store, "product_model_settings", None)
        models = settings.status()["models"] if settings else self.models
        value.update(workspace_capabilities(
            adopted["index_components"] if adopted else None, build_registered=self.builds.worker_available(),
            creation_registered=self.creation_registered, query_registered=self.query_registered,
            query_descriptor=bool((adopted or {}).get("index_descriptor_ref")), upload_limits=UPLOAD_LIMITS,
            models=models),
            generation_mode=self.mode, cq_similarity="EMBEDDING" if self.mode == "REAL" else "SIMULATED_EMBEDDING")
        if settings and not settings.ready():
            value.update(questions=False, query_status="MODEL_CONFIGURATION_REQUIRED")
        return value

    def record(self, library, kind, key, view_revision=None, at=None):
        if kind == "SOURCE" and key.startswith("document_source_"):
            return self.documents.source(library, key, view_revision)
        return super().record(library, kind, key, view_revision, at)

    def document_original(self, library, revision, view_revision):
        return self.documents.original(library, revision, view_revision)

    def document_scope(self, q, library, view, source):
        if source.startswith("document_source_"):
            for row, _, _, _ in confirmed_documents(q, library, view):
                if row["source_ref"] == source:
                    return row["doc_ref"], row["content_sha256"]
            require(False, "SOURCE_NOT_FOUND", 404)
        return None

    def workspace(self, library):
        value = super().workspace(library)
        value["documents"] = []
        with self.store.transaction(readonly=True) as (q, _):
            saved = q("""SELECT run_ref FROM product_upload_v1.uploads WHERE library_ref=%s
                         ORDER BY accepted_at DESC,run_ref DESC LIMIT 1""", [library]).fetchone()
            if saved:
                build = self.builds._read(q, library, saved["run_ref"], value["view_revision"])
                # Publish status of the active/current update remains independent from the historical build.
                value.update(run_ref=saved["run_ref"], current_build=build,
                             documents=[x[0] for x in confirmed_documents(q, library, value["view_revision"])]
                             if value["view_revision"] else [],
                             execution_status=build["execution_status"], build_gaps=build["gaps"])
                if not value["target_publication"]:
                    value["publication_status"] = build["publication_status"]
                if not value["active_view"]:
                    value["gaps"] = build["gaps"]
            if (self.builds.worker_available() and not value["counts"]["pending_jobs"]
                    and value["execution_status"] not in {"QUEUED", "RUNNING", "UNKNOWN_HOLD"}
                    and (not value["view_revision"] or saved)):
                value["available_actions"] = ["UPLOAD_DOCUMENTS"]
                if value.get("documents") and value["view_revision"]:
                    value["available_actions"].extend(("REPLACE_DOCUMENT", "REMOVE_DOCUMENT"))
        return value


def _no_usage():
    return dict(generation_requests=0, simulated_generation_requests=0, embedding_requests=0, provider_usage=[])


def _unknown_usage():
    return dict(generation_requests=None, simulated_generation_requests=None, embedding_requests=None, provider_usage=None)
