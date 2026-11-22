from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Ref = str
JobStatus = Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN_HOLD", "CANCELLED"]
PublicationStatus = Literal["NONE", "PREPARING", "PUBLISHED", "FAILED", "UNKNOWN_HOLD"]
Coverage = Literal["FULL", "PARTIAL"]
ExecutionStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "UNKNOWN_HOLD", "CANCELLED"]


class Wire(BaseModel):
    model_config = ConfigDict(extra="allow")


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkspaceCreate(Request):
    title: str = Field(min_length=1, max_length=160)
    client_operation_ref: str = Field(min_length=1, max_length=200)


class ProductModelCredential(Request):
    api_key: str = Field(min_length=1, max_length=4096)


class WorkspaceLifecycle(Request):
    action: Literal["RENAME", "ARCHIVE", "RESTORE"]
    expected_workspace_revision: int = Field(strict=True, gt=0)
    client_operation_ref: str = Field(min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=160)


class Manifest(Wire):
    view_revision: Ref
    parent_view_revision: Ref | None
    identity_revision: Ref
    ontology_revision: Ref
    time_revision: Ref
    fact_revision: Ref
    graph_revision: Ref
    index_revision: Ref
    activation_seq: int
    activated_at: str
    coverage: Coverage
    gaps: list[dict]
    index_components: dict[str, str]


class Workspace(Wire):
    library_ref: Ref
    active_view: Manifest | None
    view_revision: Ref | None
    execution_status: ExecutionStatus | None
    publication_status: PublicationStatus
    target_publication: dict | None
    counts: dict[str, int]
    gaps: list[dict]
    available_actions: list
    capabilities: dict | None = None


class Graph(Wire):
    view_revision: Ref
    scope: dict
    publication_status: Literal["PUBLISHED"]
    coverage: Coverage
    gaps: list[dict]
    graph: dict[str, list[dict]]
    summary: dict[str, int]
    selection: dict


class ViewResolve(Wire):
    view_revision: Ref
    resolved_scope: dict
    read_only: bool


class ViewItems(Wire):
    view_revision: Ref
    items: list[dict]
    next_cursor: str | None


class Preview(Wire):
    preview_ref: Ref
    base_view_revision: Ref
    before: Any
    after: Any
    impact: dict
    expires_at: str


class DecisionRequest(Request):
    contract: Literal["ontoweave-decision-request/1"]
    target_kind: str = Field(min_length=1)
    review_ref: Ref
    base_view_revision: Ref
    preview_ref: Ref | None = None
    intent: dict
    client_operation_ref: Ref = Field(min_length=1, max_length=200)


class FactCorrectionRequest(Request):
    base_view_revision: Ref
    client_operation_ref: Ref = Field(min_length=1, max_length=200)
    preview_ref: Ref | None = None
    intent: dict


class RevertRequest(Request):
    base_view_revision: Ref
    reason: str = Field(min_length=1)
    client_operation_ref: Ref = Field(min_length=1, max_length=200)
    preview_ref: Ref | None = None


class FeedbackRequest(Request):
    contract: Literal["ontoweave-ontology-feedback/1"]
    definition_ref: Ref
    base_view_revision: Ref
    business_problem: str = Field(min_length=1)
    suggested_revision: str | dict | None = None
    fact_refs: list[Ref] = Field(default_factory=list)
    source_refs: list[Ref] = Field(default_factory=list)
    client_operation_ref: Ref = Field(min_length=1, max_length=200)


class Change(Wire):
    change_ref: Ref
    from_revision: Ref | None = Field(alias="from")
    to_revision: Ref = Field(alias="to")
    decision_ref: Ref | None
    available_actions: list[Literal["REVERT"]]
    before: dict
    after: dict


class DecisionReceipt(Wire):
    contract: str
    decision_ref: Ref | None
    decision_status: Literal["SAVED", "APPLIED", "SUPERSEDED"] | None
    review_status: Literal["OPEN", "DEFERRED", "DECIDED"] | None
    job_ref: Ref | None
    job_status: JobStatus | None
    publication_status: PublicationStatus
    active_view_revision: Ref | None
    target_view_revision: Ref | None
    change_ref: Ref | None


class ErrorBody(Wire):
    code: str
    message: str
    retryable: bool
    request_ref: Ref | None
    details: dict


class ErrorEnvelope(Wire):
    error: ErrorBody


class Event(Wire):
    event_id: Ref
    library_ref: Ref
    event_type: Literal["build.stage_changed","build.progress","build.stopped","review.changed",
                        "decision.saved","job.progress","publication.published","publication.failed"]
    run_ref: Ref | None
    job_ref: Ref | None
    view_revision: Ref | None
    change_ref: Ref | None
    occurred_at: str
    payload: dict
