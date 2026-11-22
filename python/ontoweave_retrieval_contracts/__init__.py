"""Shared retrieval records and ports. Values are JSON-compatible except for the client argument."""
from collections.abc import Sequence
from typing import Literal, NotRequired, Protocol, TypedDict

RECORD_SCHEMA_VERSION = "ontoweave-retrieval-record/1"
INDEX_CONTRACT = "ontoweave-retrieval-index/1"
VIEW_CONTRACT = "ontoweave-query-read-view/1"
OFFSET_UNIT = "UNICODE_CODEPOINT"
SOURCE_PREVIEW_CODEPOINTS = 800
SOURCE_READ_CODEPOINTS = 24_000
SOURCE_HIT_LIMIT = 6

Pool = Literal["SOURCE", "KNOWLEDGE"]
Representation = Literal["SOURCE", "FACT", "OPEN"]
TemporalEligibility = Literal["UNFILTERED", "DEFINITE", "POSSIBLE", "UNKNOWN", "EXCLUDED"]


class SourceRange(TypedDict):
    source_ref: str
    doc_ref: str
    document_revision: str
    parent_block_ref: str
    unit_ref: str | None
    start: int
    end: int
    offset_unit: Literal["UNICODE_CODEPOINT"]
    precision: str


class RetrievalRecord(TypedDict):
    record_ref: str
    record_version_ref: str
    library_ref: str
    pool: Pool
    representation: Representation
    object_ref: str
    object_version_ref: str
    parent_record_ref: str | None
    text_for_search: str
    text_sha256: str
    render_version: str
    source_refs: list[SourceRange]
    entity_refs: list[str]
    definition_refs: list[str]
    state: str | None
    temporal_refs: dict
    content: dict
    source_segment_ref: str | None


class EmbeddingSpace(TypedDict):
    space_ref: str
    provider_identity: str
    endpoint_identity: str
    model: str
    model_revision: str | None
    dimensions: int
    distance_metric: Literal["COSINE"]
    normalization_policy: Literal["NONE", "L2"]
    document_profile_refs: dict[Pool, str]
    compatible_query_profile_ref: str
    profile_versions: dict[str, str]
    configuration_fingerprint: str


class Coverage(TypedDict):
    expected: int
    ready: int
    missing: int
    expected_segments: int
    ready_segments: int
    vector_ready: int
    gaps: list[dict]


class IndexDescriptor(TypedDict):
    contract: str
    index_descriptor_ref: str
    index_revision: str
    library_ref: str
    base_view_revision: str | None
    target_snapshot_digest: str
    source_manifest_ref: str
    target_revisions: dict[str, str]
    record_schema_version: str
    segment_codepoints: int
    render_versions: dict[Representation, str]
    space_refs: dict[Pool, str]
    components: dict[str, str]
    coverage: dict[Representation, Coverage]
    coverage_digest: str
    membership_digest: str
    preparation_receipt_ref: str


class QueryReadView(TypedDict):
    contract: str
    library_ref: str
    authorization_scope: str
    business_manifest_ref: str
    business_manifest_sha256: str
    view_revision: str
    graph_revision: str
    retrieval_index_revision: str | None
    index_descriptor_ref: str | None
    space_refs: dict[Pool, str]
    at: str | None
    as_of: str | None
    capabilities: dict[str, str]


class RetrievalHit(TypedDict):
    record_version_ref: str
    object_ref: str
    object_version_ref: str
    pool: Pool
    representation: Representation
    content: dict
    state: str | None
    temporal_eligibility: TemporalEligibility
    source_segment_ref: str | None
    parent_block_ref: str | None
    delivered_ranges: list[SourceRange]
    evidence_refs: list[SourceRange]
    truncated: bool
    next_cursor: str | None


class RetrievalMember(TypedDict):
    record: RetrievalRecord
    temporal_eligibility: TemporalEligibility
    space_ref: str | None
    vector_ref: str | None
    vector: list[float] | None


class SourcePage(TypedDict):
    source_segment_ref: str
    text: str
    delivered_ranges: list[SourceRange]
    truncated: bool
    next_cursor: str | None


class EmbeddingBatch(TypedDict):
    vectors: list[list[float]]
    receipt: dict


class EmbeddingClient(Protocol):
    @property
    def space(self) -> EmbeddingSpace: ...

    def embed(self, texts: Sequence[str], *, library_ref: str, profile_ref: str,
              operation_ref: str) -> EmbeddingBatch:
        """Return vectors in input order. Operation identity must survive UNKNOWN."""
        ...


class PreparedIndex(TypedDict):
    index_descriptor_ref: str
    index_revision: str
    descriptor_sha256: str


class SourceBlock(TypedDict):
    source_ref: str
    doc_ref: str
    document_revision: str
    parent_block_ref: str
    unit_ref: str | None
    text: str | None
    text_sha256: str | None
    precision: str
    title: NotRequired[str]
    gap: NotRequired[str]
