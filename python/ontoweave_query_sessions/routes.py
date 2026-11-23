"""Private Node gateway session transport, behind the existing trusted actor."""
from typing import Annotated

from fastapi import Body, Request


def mount_query_sessions(app, writer, sessions):
    if sessions is None:
        return

    @app.post("/_ontoweave/query-sessions/v1", include_in_schema=False)
    def dispatch(body: Annotated[dict, Body()], request: Request):
        writer(request)
        return sessions.dispatch(body)
