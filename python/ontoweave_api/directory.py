"""Shared directory for static and persistent product workspaces."""
from threading import RLock

from psycopg import InterfaceError, OperationalError

from ontoweave_publication.store import PublicationError, require


class WorkspaceDirectory:
    def __init__(self, static, default, *, factory, registration=None, can_create=None):
        self.static = {row["library_ref"]: row for row in static}
        self.default = default
        self.factory = factory
        self.registration = registration
        self.can_create = can_create or (lambda: False)
        self.backends = {}
        self.lock = RLock()

    def get(self, library):
        with self.lock:
            if library in self.backends:
                return self.backends[library]
            row = self.static.get(library)
            if not row and self.registration:
                row = self.registration.get(library)
            if not row:
                return None
            backend = self.factory(row)
            self.backends[library] = backend
            return backend

    def row(self, library):
        return self.static.get(library) or (self.registration.get(library) if self.registration else None)

    def rows(self, state="ACTIVE"):
        static = self.static.values() if state == "ACTIVE" else ()
        return [*static, *(self.registration.list(state) if self.registration else [])]

    def writable(self, library):
        row = self.row(library)
        require(row, "LIBRARY_NOT_FOUND", 404)
        require(row.get("workspace_state") != "ARCHIVED", "WORKSPACE_ARCHIVED")

    def names(self):
        return [row["library_ref"] for row in self.rows()]

    def _view(self, row):
        library = row["library_ref"]
        added = library not in self.static
        archived = row.get("workspace_state") == "ARCHIVED"
        fields = dict(library_ref=library, title=row["title"], backend="PG",
                      workspace_state=row.get("workspace_state", "ACTIVE"),
                      workspace_revision=row.get("workspace_revision"),
                      available_actions=(["RESTORE"] if archived else ["RENAME", "ARCHIVE"]) if added else [])
        if archived:
            return dict(fields, registration_status="READY", capabilities={})
        available = not added or self.can_create()
        try:
            capability = self.get(library)["reader"].capabilities(library)
        except (PublicationError, InterfaceError, OperationalError, OSError) as error:
            return dict(fields, registration_status="UNAVAILABLE", capabilities={},
                        reason_code=getattr(error, "code", None) or "WORKSPACE_PORTS_UNAVAILABLE")
        return dict(fields, registration_status="READY" if available else "UNAVAILABLE", capabilities=capability)

    def list(self, state="ACTIVE"):
        items = [self._view(row) for row in self.rows(state)]
        default = self.default if any(row["library_ref"] == self.default for row in items) else None
        if state == "ACTIVE" and items:
            default = default or items[0]["library_ref"]
        return dict(items=items, default_library_ref=default,
                    create_enabled=bool(state == "ACTIVE" and self.registration and self.can_create()))

    def lifecycle(self, library, actor, body):
        require(self.registration, "WORKSPACE_LIFECYCLE_UNSUPPORTED", 404)
        return self._view(self.registration.lifecycle(
            library, actor, body.action, body.expected_workspace_revision, body.client_operation_ref, body.title))

    def create(self, actor, title, operation):
        require(self.registration, "WORKSPACE_CREATION_NOT_CONFIGURED", 503)
        require(self.can_create(), "WORKSPACE_PORTS_UNAVAILABLE", 503)
        row, replay = self.registration.create(actor, title, operation)
        view = self._view(row)
        require(replay or view["registration_status"] == "READY", "WORKSPACE_PORTS_UNAVAILABLE", 503,
                library_ref=view["library_ref"])
        return view, replay
