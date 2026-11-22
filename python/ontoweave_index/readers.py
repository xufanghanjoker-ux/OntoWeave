"""Authorized, pinned retrieval reads. No method embeds document material."""
from base64 import urlsafe_b64decode, urlsafe_b64encode
import json

from ontoweave_publication.readers import Reader
from ontoweave_publication.store import digest, manifest, projection, require
from ontoweave_retrieval_contracts import SOURCE_PREVIEW_CODEPOINTS, SOURCE_READ_CODEPOINTS, VIEW_CONTRACT

from . import sources
from .embedding import EmbeddingCache, get_space, validate_vector
from .material import graph_source, locator, text_sha
from .repository import BUSINESS_KINDS, REVISION_FIELDS, members, read_descriptor


class RetrievalReader:
    def __init__(self, store, *, authorize, world_time_filter=None, certified_descriptors=None):
        self.store = store
        self.authorize = authorize
        self.world_time_filter = world_time_filter
        self.reader = Reader(store, world_time_filter=world_time_filter)
        self.cache = EmbeddingCache(store)
        self.certified_descriptors = dict(certified_descriptors or {})

    def _authorize(self, library, scope):
        require(isinstance(scope, str) and scope and self.authorize(library, scope),
                "QUERY_AUTHORIZATION_REVOKED", 403)

    def open_query_view(self, library_ref, authorization_scope, *, at=None, as_of=None,
                        view_revision=None, index_descriptor_ref=None):
        self._authorize(library_ref, authorization_scope)
        resolved = self.reader.resolve(library_ref, at=at, as_of=as_of, view_revision=view_revision)
        revision = resolved["view_revision"]
        with self.store.transaction(readonly=True) as (q, _):
            adopted = manifest(q, library_ref, revision)
            descriptor = self._descriptor(q, adopted, index_descriptor_ref or self.certified_descriptors.get(revision))
        return self._view(adopted, descriptor, authorization_scope, **{
            key: resolved["resolved_scope"][key] for key in ("at", "as_of")})

    @staticmethod
    def _view(adopted, descriptor, scope, *, at, as_of):
        legacy = {("legacy_" + k if k != "entity_name" else k): v for k,v in adopted["index_components"].items()
                  if k in {"entity_name", "fact_lexical", "source_lexical"}}
        capabilities = descriptor["components"] if descriptor else legacy
        return dict(contract=VIEW_CONTRACT, library_ref=adopted["library_ref"], authorization_scope=scope,
                    business_manifest_ref=adopted["view_revision"], business_manifest_sha256=digest(adopted),
                    view_revision=adopted["view_revision"], graph_revision=adopted["graph_revision"],
                    retrieval_index_revision=descriptor["index_revision"] if descriptor else None,
                    index_descriptor_ref=descriptor["index_descriptor_ref"] if descriptor else None,
                    space_refs=descriptor["space_refs"] if descriptor else {}, at=at, as_of=as_of,
                    capabilities=capabilities)

    @staticmethod
    def _descriptor(q, adopted, requested):
        bound = adopted.get("index_descriptor_ref")
        if requested is None:
            requested = bound
        if requested is None:
            return None
        library, view = adopted["library_ref"], adopted["view_revision"]
        if requested == bound:
            descriptor = read_descriptor(q, library, requested)
            require(descriptor["index_revision"] == adopted["index_revision"]
                    and digest(descriptor) == adopted.get("index_descriptor_sha256"),
                    "QUERY_INDEX_MANIFEST_MISMATCH", 503)
        else:
            available = q("SELECT to_regclass('retrieval_v1.historical_certifications') AS t").fetchone()["t"]
            row = q("""SELECT manifest_sha,descriptor_sha FROM retrieval_v1.historical_certifications
                       WHERE library_ref=%s AND view_revision=%s AND index_descriptor_ref=%s""",
                    [library, view, requested]).fetchone() if available else None
            require(row and row["manifest_sha"] == digest(adopted), "QUERY_HISTORICAL_INDEX_UNCERTIFIED", 422)
            descriptor = read_descriptor(q, library, requested)
            require(row["descriptor_sha"] == digest(descriptor)
                    and descriptor["base_view_revision"] == view, "QUERY_INDEX_MANIFEST_MISMATCH", 503)
        require(descriptor["source_manifest_ref"] == adopted["source_manifest_ref"]
                and descriptor["target_revisions"] == {field: adopted[field] for field in REVISION_FIELDS},
                "QUERY_INDEX_MANIFEST_MISMATCH", 503)
        return descriptor

    def _bound(self, q, view):
        library, scope = view["library_ref"], view["authorization_scope"]
        self._authorize(library, scope)
        adopted = manifest(q, library, view["view_revision"])
        descriptor = self._descriptor(q, adopted, view["index_descriptor_ref"])
        require(view == self._view(adopted, descriptor, scope, at=view["at"], as_of=view["as_of"]),
                "QUERY_READ_VIEW_BINDING_CHANGED", 409)
        return adopted, descriptor

    def load_index_descriptor(self, view):
        with self.store.transaction(readonly=True) as (q, _):
            return self._bound(q, view)[1]

    def load_embedding_space(self, view, pool):
        require(pool in {"SOURCE", "KNOWLEDGE"}, "QUERY_POOL_INVALID", 422)
        with self.store.transaction(readonly=True) as (q, _):
            _, descriptor = self._bound(q, view)
            space_ref = descriptor["space_refs"].get(pool) if descriptor else None
            return get_space(q, space_ref) if space_ref else None

    def load_graph(self, view):
        with self.store.transaction(readonly=True) as (q, _):
            adopted, _ = self._bound(q, view)
            rows = projection(q, view["library_ref"], view["view_revision"], BUSINESS_KINDS)
        if view["at"]:
            require(self.world_time_filter, "WORLD_TIME_FILTER_UNAVAILABLE", 422)
            return self.world_time_filter(view["library_ref"], adopted, rows, view["at"])
        return rows

    def load_retrieval_records(self, view, pool, *, representations=None, include_vectors=True):
        require(pool in {"SOURCE", "KNOWLEDGE"}, "QUERY_POOL_INVALID", 422)
        allowed = {"SOURCE"} if pool == "SOURCE" else {"FACT", "OPEN"}
        kinds = allowed if representations is None else set(representations)
        require(kinds <= allowed, "QUERY_REPRESENTATION_INVALID", 422)
        with self.store.transaction(readonly=True) as (q, _):
            adopted, descriptor = self._bound(q, view)
            if descriptor is None:
                return []
            library = view["library_ref"]
            rows = [row for row in members(q, library, descriptor, include_vectors=include_vectors)
                    if row["body"]["representation"] in kinds]
            space_ref = descriptor["space_refs"].get(pool)
            space = get_space(q, space_ref) if space_ref else None
            fact_rows = projection(q, library, view["view_revision"], ("FACT",)) if pool == "KNOWLEDGE" and view["at"] else {}
        if pool == "KNOWLEDGE" and view["at"]:
            require(self.world_time_filter, "WORLD_TIME_FILTER_UNAVAILABLE", 422)
            fact_rows = self.world_time_filter(library, adopted, fact_rows, view["at"])
        result = []
        for row in rows:
            record = row["body"]
            status = self._eligibility(view, record, fact_rows)
            if status == "EXCLUDED":
                continue
            vector = None
            if include_vectors and row["vector_ref"]:
                require(space and row["wire"], "INDEX_MEMBER_VECTOR_MISSING", 503)
                # Read the stored float32 values without applying normalization a second time.
                vector = validate_vector(json.loads(row["wire"]), dict(space, normalization_policy="NONE"))
            result.append(dict(record=record, temporal_eligibility=status, space_ref=row["space_ref"],
                               vector_ref=row["vector_ref"], vector=vector))
        return result

    @staticmethod
    def _eligibility(view, record, fact_rows):
        if not view["at"] or record["representation"] == "SOURCE":
            return "UNFILTERED"
        if record["representation"] == "OPEN":
            return "UNKNOWN"
        match = fact_rows.get(("FACT", record["object_ref"]))
        if match is None:
            return "EXCLUDED"
        status = (match.get("world_match") or {}).get("status")
        return {"CERTAIN": "DEFINITE", "DEFINITE": "DEFINITE", "SUPPORTED": "DEFINITE",
                "POSSIBLE": "POSSIBLE", "EXCLUDED": "EXCLUDED"}.get(status, "UNKNOWN")

    def load_source_range(self, view, source_segment_ref, *, cursor=None, limit=SOURCE_READ_CODEPOINTS):
        require(type(limit) is int and 0 < limit <= SOURCE_READ_CODEPOINTS, "QUERY_SOURCE_LIMIT_INVALID", 422)
        with self.store.transaction(readonly=True) as (q, _):
            adopted, descriptor = self._bound(q, view)
            data, start, stop = self._source(q, adopted, descriptor, source_segment_ref)
        pin = digest([view, source_segment_ref])
        current = self._cursor(cursor, pin, start, len(data["text"])) if cursor else start
        end = min(len(data["text"]), current+limit, len(data["text"]) if cursor or limit != SOURCE_PREVIEW_CODEPOINTS else stop)
        next_cursor = urlsafe_b64encode(f"{pin}:{end}".encode()).decode() if end < len(data["text"]) else None
        position = {key: value for key, value in data.items() if key != "text"}
        return dict(source_segment_ref=source_segment_ref, text=data["text"][current:end],
                    delivered_ranges=[dict(position, start=current,end=end)], truncated=bool(next_cursor),
                    next_cursor=next_cursor)

    def read_original(self, view, source_ref, *, start=0, limit=SOURCE_READ_CODEPOINTS):
        require(type(start) is int and start >= 0 and type(limit) is int and 0 < limit <= SOURCE_READ_CODEPOINTS,
                "QUERY_SOURCE_LIMIT_INVALID", 422)
        with self.store.transaction(readonly=True) as (q, _):
            adopted, descriptor = self._bound(q, view)
            data, _, _ = self._source(q, adopted, descriptor, source_ref)
        text = data["text"]
        require(start < len(text), "QUERY_SOURCE_RANGE_INVALID", 422)
        end = min(start + limit, len(text))
        return dict(text=text[start:end], location={**{k: v for k, v in data.items() if k != "text"},
                                                   "start": start, "end": end},
                    source_length=len(text), truncated=end < len(text))

    @staticmethod
    def _cursor(cursor, pin, start, length):
        try:
            prefix, offset = urlsafe_b64decode(cursor).decode().split(":")
            position = int(offset)
        except (ValueError, TypeError, UnicodeError):
            require(False, "QUERY_SOURCE_CURSOR_INVALID", 422)
        require(prefix == pin and start < position < length, "QUERY_SOURCE_CURSOR_INVALID", 422)
        return position

    @staticmethod
    def _source(q, adopted, descriptor, key):
        library = adopted["library_ref"]
        if descriptor:
            inventory = sources.read(q, library, descriptor["source_manifest_ref"])
            original = next((block for block in inventory["body"]["blocks"] if block["source_ref"] == key), None)
            if original and original["text"]:
                return dict(locator(original, len(original["text"])), text=original["text"]), 0, len(original["text"])
            candidates = [row["body"] for row in members(q, library, descriptor)
                          if row["body"]["source_segment_ref"] == key]
            if candidates:
                require(len(candidates) == 1, "QUERY_SOURCE_SEGMENT_AMBIGUOUS", 503)
                record = candidates[0]
                source = record["source_refs"][0]
                parent = next((block for block in inventory["body"]["blocks"] if block["source_ref"] == source["source_ref"]), None)
                require(parent and parent["text"] and source == locator(parent, source["end"], source["start"])
                        and text_sha(parent["text"][source["start"]:source["end"]]) == record["text_sha256"],
                        "QUERY_SOURCE_RANGE_BINDING_CHANGED", 503)
                return dict(source, text=parent["text"]), source["start"], source["end"]
        graph = projection(q, library, adopted["view_revision"], ("SOURCE",))
        row = graph.get(("SOURCE", key))
        data = graph_source(row) if row else None
        require(data, "QUERY_SOURCE_NOT_IN_VIEW", 404)
        return data, 0, len(data["text"])

    def load_query_vector(self, view, pool, text, *, client, operation_ref):
        require(isinstance(text, str) and text.strip() and operation_ref, "QUERY_EMBEDDING_INPUT_INVALID", 422)
        space = self.load_embedding_space(view, pool)
        require(space and client and client.space == space, "QUERY_EMBEDDING_SPACE_UNAVAILABLE", 422)
        maximum = getattr(client, "max_input_utf8_bytes", None)
        require(maximum is None or len(text.encode("utf-8")) <= maximum, "QUERY_EMBEDDING_INPUT_LIMIT", 422)
        key = text_sha(text)
        found, gaps, _ = self.cache.resolve(view["library_ref"], space, space["compatible_query_profile_ref"],
                                              {key: text}, client=client, operation=operation_ref)
        self._authorize(view["library_ref"], view["authorization_scope"])
        require(key in found, gaps.get(key) or "QUERY_EMBEDDING_UNAVAILABLE", 503)
        return validate_vector(json.loads(found[key]["wire"]), dict(space, normalization_policy="NONE"))
