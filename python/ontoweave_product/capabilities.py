"""Capabilities derived from registered ports and the exact confirmed manifest."""


def workspace_capabilities(components, *, build_registered=False, query_registered=False,
                           creation_registered=False, query_descriptor=False, upload_limits=None, models=None):
    # The current QueryService exposes source/knowledge and entity tools from these exact components.
    if not query_registered:
        query_status = "NOT_CONFIGURED"
    elif components is None:
        query_status = "AWAITING_PUBLICATION"
    elif query_descriptor and any(components.get(key) in {"READY", "READY_EMPTY", "PARTIAL"}
             for key in ("source_lexical", "knowledge_lexical", "entity_name")):
        query_status = "READY"
    else:
        query_status = "NO_SEARCHABLE_INDEX"
    return dict(questions=query_status == "READY", query_registered=query_registered, query_status=query_status,
                build_registered=build_registered, creation_registered=creation_registered,
                upload_mode="VERSIONED" if build_registered else "READ_ONLY",
                initial_upload_only=False, upload_limits=upload_limits if build_registered else None,
                models=models or {}, index_components=dict(components or {}))
