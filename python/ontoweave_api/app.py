import asyncio
import hmac
import json
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Body, FastAPI, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg import InterfaceError, OperationalError

from ontoweave_cq.store import CQStoreError
from ontoweave_publication.store import PublicationError, ref, require
from .contracts import (
    Change, DecisionReceipt, DecisionRequest, ErrorEnvelope, Event, FactCorrectionRequest, FeedbackRequest, Graph, Preview, ProductModelCredential,
    RevertRequest, ViewItems, ViewResolve, Workspace, WorkspaceCreate, WorkspaceLifecycle,
)

PREFIX = "/api/v1/libraries/{library_ref}"
HANDOFF = Path(__file__).resolve().parents[2] / "local-runs/ontology-facts-ui-integration-v1/publication/handoff"
ERRORS = {status: {"model": ErrorEnvelope} for status in (403, 404, 409, 422, 503)}
Limit = Annotated[int, Query(ge=1, le=500)]


def create_app(backends, *, actor=None, write_token=None, directory=None, model_settings=None):
    # The registry maps exact library references to explicit PG backends.
    app = FastAPI(title="OntoWeave Publication API", version="1.0.0",
                  openapi_url="/api/v1/openapi.json", docs_url=None, redoc_url=None)
    router = APIRouter(prefix=PREFIX, responses=ERRORS)

    def backend(library):
        selected = directory.get(library) if directory else backends.get(library)
        require(selected, "LIBRARY_NOT_FOUND", 404)
        return selected

    def writer(req, library=None):
        supplied = req.headers.get("x-ontoweave-write-token", "")
        require(actor and write_token and hmac.compare_digest(supplied.encode(), write_token.encode()),
                "TRUSTED_ACTOR_REQUIRED", 403)
        if directory and library:
            directory.writable(library)
        return actor

    def unavailable():
        raise PublicationError("BUILD_ADAPTER_UNAVAILABLE", 503)

    @app.exception_handler(PublicationError)
    async def publication_error(request, exc):
        return JSONResponse(status_code=exc.status, content={"error": {
            "code": exc.code, "message": {"VIEW_BASE_STALE": "知识已更新，请重新预览",
                                        "PREVIEW_EXPIRED": "预览已过期，请重新预览"}.get(exc.code, exc.code),
            "retryable": False, "request_ref": request.headers.get("x-request-id"), "details": exc.details}})

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        details = {"fields": [list(error["loc"]) for error in exc.errors()]}
        return await publication_error(request, PublicationError("REQUEST_INVALID", 422, details))

    @app.exception_handler(CQStoreError)
    async def domain_error(request, exc):
        status = (422 if exc.code.startswith(("FACT_INTENT_", "TEMPORAL_INPUT_"))
                  else 409 if exc.code.endswith("_STALE") else 503)
        return await publication_error(request, PublicationError(exc.code, status))

    @app.exception_handler(OperationalError)
    @app.exception_handler(InterfaceError)
    async def pg_unavailable(request, _exc):
        return await publication_error(request, PublicationError("PG_UNAVAILABLE", 503))

    @app.get("/api/v1/models")
    def models_status():
        require(model_settings, "MODEL_SETTINGS_UNAVAILABLE", 404)
        return model_settings.status()

    @app.post("/api/v1/models")
    def save_models(body: ProductModelCredential, request: Request):
        writer(request)
        require(model_settings, "MODEL_SETTINGS_UNAVAILABLE", 404)
        return model_settings.save(body.api_key)

    @app.get("/api/v1/libraries")
    def libraries(state: Literal["ACTIVE", "ARCHIVED"] = "ACTIVE"):
        require(directory, "WORKSPACE_REGISTRY_UNAVAILABLE", 503)
        return directory.list(state)

    @app.post("/api/v1/libraries", status_code=201)
    def create_library(body: WorkspaceCreate, request: Request, response: Response):
        principal = writer(request)
        require(directory, "WORKSPACE_CREATION_NOT_CONFIGURED", 503)
        result, replay = directory.create(principal, body.title, body.client_operation_ref)
        response.status_code = 200 if replay else 201
        return result

    @router.post("/lifecycle")
    def lifecycle(library_ref: str, body: WorkspaceLifecycle, request: Request):
        principal = writer(request)
        require(directory, "WORKSPACE_LIFECYCLE_UNSUPPORTED", 404)
        return directory.lifecycle(library_ref, principal, body)

    @app.get("/_ontoweave/libraries/{library_ref}", include_in_schema=False)
    def authorize_library(library_ref: str, request: Request):
        writer(request)
        return dict(library_ref=library_ref, query_registered=bool(backend(library_ref).get("query")),
                    model_ready=not model_settings or model_settings.ready(), workspace_state=(directory.row(library_ref) or {}).get("workspace_state", "ACTIVE") if directory else "ACTIVE")

    @app.post("/_ontoweave/query/{library_ref}/{action}", include_in_schema=False)
    def query_internal(library_ref: str, action: str, body: Annotated[dict, Body()], request: Request):
        actor_scope = writer(request)
        selected = backend(library_ref).get("query")
        require(selected, "QUERY_ADAPTER_UNAVAILABLE", 503)
        fields = {
            "open": {"at", "as_of", "view_revision", "index_descriptor_ref"},
            "verify": {"view"},
            "close": {"view", "query_id"},
            "call": {"view", "query_id", "name", "args", "operation_ref"},
        }
        require(action in fields and set(body) <= fields[action] and (action == "open" or set(body) == fields[action]),
                "QUERY_INTERNAL_REQUEST_INVALID", 422)
        from ontoweave_query import QueryError

        try:
            return selected.dispatch(library_ref, actor_scope, action, body)
        except QueryError as error:
            code = error.code
            raise PublicationError(code, 503 if "UNKNOWN" in code else 422) from None

    @router.get("/retrieval/sources/{source_ref}")
    def retrieval_source(library_ref: str, source_ref: str, view_revision: str,
                         index_descriptor_ref: str | None = None, start: int = 0, limit: int = 24_000):
        reader = backend(library_ref).get("retrieval")
        require(actor and reader, "QUERY_ADAPTER_UNAVAILABLE", 503)
        view = reader.open_query_view(library_ref, actor, view_revision=view_revision,
                                      index_descriptor_ref=index_descriptor_ref)
        return dict(reader.read_original(view, source_ref, start=start, limit=limit),
                    view_revision=view["view_revision"], index_descriptor_ref=view["index_descriptor_ref"])

    @router.get("/view", response_model=Workspace)
    def workspace(library_ref: str):
        value = backend(library_ref)["reader"].workspace(library_ref)
        if directory:
            row = directory.row(library_ref)
            value["workspace_state"] = row.get("workspace_state", "ACTIVE")
            if value["workspace_state"] == "ARCHIVED":
                value["available_actions"] = []
                for key in ("build_registered", "questions", "runs_human_jobs"):
                    value["capabilities"][key] = False
                value["capabilities"]["upload_mode"] = "READ_ONLY"
        return value

    @router.get("/views/resolve", response_model=ViewResolve)
    def resolve(library_ref: str, at: str | None = None, as_of: str | None = None,
                view_revision: str | None = None):
        return backend(library_ref)["reader"].resolve(library_ref, at=at, as_of=as_of, view_revision=view_revision)

    @router.get("/graph", response_model=Graph)
    def graph(library_ref: str, view_revision: str | None = None, at: str | None = None,
              cursor: str | None = None, limit: Limit = 200):
        return backend(library_ref)["reader"].graph(library_ref, view_revision, at, cursor, limit)

    @router.get("/graph/delta")
    def graph_delta(library_ref: str, previous: Annotated[str, Query(alias="from")],
                    target: Annotated[str, Query(alias="to")], at: str | None = None):
        return backend(library_ref)["reader"].delta(library_ref, previous, target, at)

    @router.get("/ontology", response_model=ViewItems)
    def ontology(library_ref: str, view_revision: str | None = None, cursor: str | None = None, limit: Limit = 100):
        return backend(library_ref)["reader"].list(library_ref, "DEFINITION", view_revision, cursor, limit)

    @router.get("/ontology/{definition_ref}")
    def definition(library_ref: str, definition_ref: str, view_revision: str | None = None):
        return backend(library_ref)["reader"].record(library_ref, "DEFINITION", definition_ref, view_revision)

    @router.post("/ontology/{definition_ref}/feedback", status_code=201, responses={200: {"description": "Replay"}})
    def feedback(library_ref: str, definition_ref: str, body: FeedbackRequest, request: Request, response: Response):
        result, reused = backend(library_ref)["decisions"].feedback(library_ref, writer(request, library_ref), definition_ref,
                                                                  body.model_dump())
        response.status_code = 200 if reused else 201
        return result

    @router.get("/knowledge", response_model=ViewItems)
    def knowledge_list(library_ref: str, view_revision: str | None = None,
                       kind: Literal["FACT","OPEN"] | None = None, source_ref: str | None = None,
                       cursor: str | None = None, limit: Limit = 100):
        return backend(library_ref)["reader"].knowledge(library_ref, view_revision, kind, source_ref, cursor, limit)

    @router.get("/knowledge/{fact_ref}")
    def knowledge(library_ref: str, fact_ref: str, view_revision: str | None = None, at: str | None = None,
                  kind: Literal["FACT","OPEN"] = "FACT"):
        row = backend(library_ref)["reader"].record(
            library_ref, "FACT" if kind == "FACT" else "STATEMENT", fact_ref, view_revision, at)
        require(kind == "FACT" or row.get("routing_result") == "OPEN_UNINTERPRETED", "KNOWLEDGE_NOT_FOUND", 404)
        return dict(row, kind=kind, knowledge_ref=fact_ref)

    def correction_request(library, fact, body):
        review = ref("fact_correction", library, fact, body.base_view_revision)
        return review, dict(body.model_dump(), review_ref=review, target_kind="FACT", proactive_fact_ref=fact)

    @router.get("/knowledge/{fact_ref}/correction")
    def correction_basis(library_ref: str, fact_ref: str, view_revision: str):
        require(directory is None or (directory.row(library_ref) or {}).get("workspace_state") != "ARCHIVED",
                "WORKSPACE_ARCHIVED")
        return backend(library_ref)["decisions"].fact_correction_basis(library_ref, fact_ref, view_revision)

    @router.post("/knowledge/{fact_ref}/correction/preview", response_model=Preview)
    def correction_preview(library_ref: str, fact_ref: str, body: FactCorrectionRequest, request: Request):
        actor_ref = writer(request, library_ref)
        target, payload = correction_request(library_ref, fact_ref, body)
        return backend(library_ref)["decisions"].preview(library_ref, actor_ref, target, payload)

    @router.post("/knowledge/{fact_ref}/correction", status_code=202, response_model=DecisionReceipt)
    def save_correction(library_ref: str, fact_ref: str, body: FactCorrectionRequest, request: Request, response: Response):
        actor_ref = writer(request, library_ref)
        target, payload = correction_request(library_ref, fact_ref, body)
        result, replay = backend(library_ref)["decisions"].save(library_ref, actor_ref, target, payload)
        response.status_code = 200 if replay else 202
        return result

    @router.get("/sources/{source_ref}")
    def source(library_ref: str, source_ref: str, view_revision: str | None = None):
        return backend(library_ref)["reader"].record(library_ref, "SOURCE", source_ref, view_revision)

    @router.get("/documents/{document_revision_ref}/original")
    def original_document(library_ref: str, document_revision_ref: str, view_revision: str):
        reader = backend(library_ref)["reader"]
        require(hasattr(reader, "document_original"), "DOCUMENT_ORIGINAL_UNAVAILABLE", 404)
        document, payload = reader.document_original(library_ref, document_revision_ref, view_revision)
        disposition = "attachment; filename*=UTF-8''" + quote(document["filename"], safe="")
        return Response(content=payload, media_type="application/octet-stream", headers={
            "Content-Disposition": disposition, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })

    @router.get("/reviews", response_model=ViewItems)
    def reviews(library_ref: str, view_revision: str | None = None, cursor: str | None = None, limit: Limit = 100,
                status: str | None = None):
        require(status in {None, "OPEN", "DEFERRED", "DECIDED"}, "REVIEW_STATUS_INVALID", 422)
        return backend(library_ref)["reader"].list(library_ref, "REVIEW", view_revision, cursor, limit, status)

    @router.get("/reviews/{review_ref}")
    def review(library_ref: str, review_ref: str, view_revision: str | None = None):
        return backend(library_ref)["reader"].record(library_ref, "REVIEW", review_ref, view_revision)

    @router.post("/reviews/{review_ref}/preview", response_model=Preview)
    def preview(library_ref: str, review_ref: str, body: DecisionRequest, request: Request):
        return backend(library_ref)["decisions"].preview(library_ref, writer(request, library_ref), review_ref, body.model_dump())

    @router.post("/reviews/{review_ref}/decisions", status_code=202, response_model=DecisionReceipt,
                 responses={200: {"model": DecisionReceipt}})
    def decide(library_ref: str, review_ref: str, body: DecisionRequest, request: Request, response: Response):
        result, reused = backend(library_ref)["decisions"].save(library_ref, writer(request, library_ref), review_ref,
                                                              body.model_dump())
        response.status_code = 200 if reused else 202
        return result

    @router.post("/decisions/{decision_ref}/revert-preview", response_model=Preview)
    def revert_preview(library_ref: str, decision_ref: str, body: RevertRequest, request: Request):
        return backend(library_ref)["decisions"].preview(library_ref, writer(request, library_ref), decision_ref, body.model_dump(),
                                                       revert=True)

    @router.post("/decisions/{decision_ref}/revert", status_code=202, response_model=DecisionReceipt,
                 responses={200: {"model": DecisionReceipt}})
    def revert(library_ref: str, decision_ref: str, body: RevertRequest, request: Request, response: Response):
        result, reused = backend(library_ref)["decisions"].save(library_ref, writer(request, library_ref), decision_ref,
                                                              body.model_dump(), revert=True)
        response.status_code = 200 if reused else 202
        return result

    @router.get("/jobs/{job_ref}", response_model=DecisionReceipt)
    def job(library_ref: str, job_ref: str):
        return backend(library_ref)["reader"].job(library_ref, job_ref)

    @router.get("/changes/{change_ref}", response_model=Change)
    def change(library_ref: str, change_ref: str):
        return backend(library_ref)["reader"].change(library_ref, change_ref)

    @router.get("/events", response_class=StreamingResponse,
                responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}})
    async def stream(library_ref: str, request: Request, last_event_id: Annotated[str | None, Header()] = None):
        reader = backend(library_ref)["reader"]
        first = await asyncio.to_thread(reader.events, library_ref, last_event_id)

        async def generate():
            cursor, rows = last_event_id, first
            yield ": connected\n\n"
            delay = 0
            while not await request.is_disconnected():
                if rows is None:
                    yield 'event: stream.resync\ndata: {"reason":"CURSOR_UNAVAILABLE"}\n\n'
                    return
                for row in rows:
                    wire = Event.model_validate(row)
                    cursor = wire.event_id
                    yield f"id: {cursor}\nevent: {wire.event_type}\ndata: {wire.model_dump_json()}\n\n"
                delay = (delay + 1) if not rows else 0
                if delay == 15:
                    yield ": heartbeat\n\n"
                    delay = 0
                if len(rows) < 100:
                    await asyncio.sleep(1)
                rows = await asyncio.to_thread(reader.events, library_ref, cursor)

        return StreamingResponse(generate(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @router.get("/builds/{run_ref}")
    def build(library_ref: str, run_ref: str):
        selected = backend(library_ref)
        return selected["build"].read(library_ref, run_ref) if selected.get("build") else unavailable()

    @router.post("/documents", status_code=202)
    def documents(library_ref: str, request: Request, files: Annotated[list[UploadFile] | None, File()] = None,
                  client_operation_ref: Annotated[str | None, Form()] = None,
                  action: Annotated[Literal["APPEND", "REPLACE", "REMOVE"] | None, Form()] = None,
                  base_view_revision: Annotated[str | None, Form()] = None,
                  document_ref: Annotated[str | None, Form()] = None):
        actor_ref = writer(request, library_ref)
        selected = backend(library_ref)
        if not selected.get("build"):
            return unavailable()
        if action or base_view_revision or document_ref:
            return selected["build"].receive(library_ref, actor_ref, files or [], client_operation_ref,
                                             action=action or "APPEND", base=base_view_revision,
                                             document_ref=document_ref)
        return selected["build"].receive(library_ref, actor_ref, files or [], client_operation_ref)

    @router.post("/builds/{run_ref}/resume-preview")
    def resume_preview(library_ref: str, run_ref: str, request: Request, body: Annotated[dict, Body()]):
        actor_ref = writer(request, library_ref)
        selected = backend(library_ref)
        return selected["build"].resume_preview(library_ref, run_ref, actor_ref, body) if selected.get("build") else unavailable()

    @router.post("/builds/{run_ref}/resume", status_code=202)
    def resume(library_ref: str, run_ref: str, request: Request, body: Annotated[dict, Body()]):
        actor_ref = writer(request, library_ref)
        selected = backend(library_ref)
        return selected["build"].resume(library_ref, run_ref, actor_ref, body) if selected.get("build") else unavailable()

    @router.post("/builds/{run_ref}/reconcile")
    def reconcile(library_ref: str, run_ref: str, request: Request, body: Annotated[dict, Body()]):
        actor_ref = writer(request, library_ref)
        selected = backend(library_ref)
        return selected["build"].reconcile(library_ref, run_ref, actor_ref, body) if selected.get("build") else unavailable()

    app.include_router(router)
    return app


def export_openapi():
    schema = create_app({}).openapi()
    fixtures = json.loads((HANDOFF / "api-fixtures.json").read_text())
    examples = {
        ("post","/documents"): ("202","documents_accepted"),
        ("get","/view"): ("200","view_first"), ("get","/views/resolve"): ("200","view_resolved"),
        ("get","/builds/{run_ref}"): ("200","build"), ("get","/graph"): ("200","graph"),
        ("get","/graph/delta"): ("200","graph_delta"), ("get","/ontology"): ("200","ontology"),
        ("get","/ontology/{definition_ref}"): ("200","ontology_detail"),
        ("post","/ontology/{definition_ref}/feedback"): ("201","ontology_feedback"),
        ("get","/knowledge/{fact_ref}"): ("200","knowledge"), ("get","/sources/{source_ref}"): ("200","source"),
        ("get","/reviews"): ("200","reviews"), ("get","/reviews/{review_ref}"): ("200","review_detail"),
        ("post","/reviews/{review_ref}/preview"): ("200","review_preview"),
        ("post","/reviews/{review_ref}/decisions"): ("202","decision_saved"),
        ("get","/jobs/{job_ref}"): ("200","job_applied"), ("get","/changes/{change_ref}"): ("200","change"),
    }
    for (method, path), (status, example) in examples.items():
        content = schema["paths"][PREFIX + path][method]["responses"][status]["content"]
        content["application/json"]["example"] = fixtures["responses"][example]
    schema["paths"][PREFIX + "/events"]["get"]["responses"]["200"]["content"]["text/event-stream"]["example"] = (
        HANDOFF / "events.sse").read_text()
    schema["components"]["schemas"]["Event"] = Event.model_json_schema()
    return schema
