"""Load an explicit identity revision without consulting or moving active views."""

from ontoweave_cq.store import require
from ontoweave_identity.storage import bindings_at, source_state


def load_identity(store, library_ref, identity_revision):
    with store.transaction(readonly=True) as (q, _):
        version = q("""SELECT revision FROM identity_v1.revisions
                       WHERE library_ref=%s AND identity_revision=%s""",
                    [library_ref, identity_revision]).fetchone()
        require(version, "ONTOLOGY_IDENTITY_REVISION_UNKNOWN")
        _, occurrences, statements = source_state(q, library_ref, version["revision"])
        bindings = bindings_at(q, library_ref, version["revision"])
    return dict(library_ref=library_ref, identity_revision=identity_revision, statements=statements,
                occurrences=occurrences, bindings=bindings)
