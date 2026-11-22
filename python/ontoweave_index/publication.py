"""Integration between optional retrieval configuration and the single Publisher."""
from psycopg.types.json import Jsonb

from ontoweave_publication.store import digest, get_job, head, manifest, require

from .embedding import get_space
from .repository import IndexRepository, read_descriptor


class PublicationIndex:
    def __init__(self, store, *, client=None, segment_codepoints=None):
        self.store = store
        self.repository = IndexRepository(store)
        self.client = client
        self.segment_codepoints = segment_codepoints

    def enabled(self, adopted):
        return self.segment_codepoints is not None or bool(adopted and adopted.get("index_descriptor_ref"))

    def prepare(self, publication, graph):
        library, base = publication["library_ref"], publication["base_view_revision"]
        source_ref = publication["source_manifest_ref"]
        client, space, segment_size = self.client, None, self.segment_codepoints
        with self.store.transaction(readonly=True) as (q, _):
            parent = manifest(q, library, base) if base else None
            registered = q("""SELECT 1 FROM retrieval_v1.source_manifests
                              WHERE library_ref=%s AND source_manifest_ref=%s""", [library, source_ref]).fetchone()
            if parent and parent.get("index_descriptor_ref"):
                previous = read_descriptor(q, library, parent["index_descriptor_ref"])
                segment_size = segment_size or previous["segment_codepoints"]
                spaces = set(previous["space_refs"].values())
                require(len(spaces) <= 1, "INDEX_PUBLICATION_SPACE_AMBIGUOUS", 422)
                if spaces and client is None:
                    space = get_space(q, next(iter(spaces)))
        require(segment_size, "INDEX_SEGMENT_SIZE_REQUIRED", 422)
        if not registered and publication.get("run_ref"):
            self.repository.register_saved_source_manifest(library, source_ref, publication["run_ref"])
        elif not registered and parent and parent["source_manifest_ref"] == source_ref:
            self.repository.register_confirmed_sources(library, base)
        return self.repository.prepare_index(publication, graph, client=client, space=space,
                                             segment_codepoints=segment_size, operation_ref=publication["request_ref"])

    def prepare_job(self, library, job, publication, graph):
        with self.store.transaction(readonly=True) as (q, _):
            saved = self._job_preparation(q, library, job)
            if saved is None:
                require(head(q, library)["active_view_revision"] == publication["base_view_revision"],
                        "VIEW_BASE_STALE")
        if saved is not None:
            return saved
        prepared = self.prepare(publication, graph)
        with self.store.transaction() as (q, _):
            info = get_job(q, library, job)
            require(info["input_sha"] == digest(publication), "INDEX_JOB_BASIS_MISMATCH", 409)
            q("""INSERT INTO retrieval_v1.job_preparations VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
              [library, job, Jsonb(prepared), digest(prepared)])
            saved = self._job_preparation(q, library, job)
            require(saved == prepared, "INDEX_JOB_PREPARATION_CONFLICT", 409)
        return saved

    @staticmethod
    def _job_preparation(q, library, job):
        row = q("""SELECT body,body_sha FROM retrieval_v1.job_preparations
                   WHERE library_ref=%s AND job_ref=%s""", [library, job]).fetchone()
        if row:
            require(row["body_sha"] == digest(row["body"]), "INDEX_JOB_PREPARATION_DIGEST_MISMATCH", 503)
            return row["body"]
        return None
