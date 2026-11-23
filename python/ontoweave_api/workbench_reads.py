"""Version-bound, read-only projections for the PG workbench."""

import re
from collections import defaultdict
from typing import Annotated, Literal

from fastapi import Query

from ontoweave_index import sources
from ontoweave_index.material import graph_source
from ontoweave_publication.integration import confirmed_history
from ontoweave_publication.readers import _iso_time, _page, _read_view, _scope
from ontoweave_publication.store import digest, projection, ref, require

PageLimit = Annotated[int, Query(ge=1, le=200)]


def _graph(reader, library, view, at, *, definitions=False):
    if at is not None:
        _iso_time(at, "WORLD_TIME_INVALID")
    with reader.store.transaction(readonly=True) as (q, _):
        adopted = _read_view(q, library, view)
        kinds = ("NODE", "EDGE", "FACT", "DEFINITION") if definitions else ("NODE", "EDGE", "FACT")
        rows = projection(q, library, adopted["view_revision"], kinds)
    scoped = reader._world_rows(library, adopted, rows, at)
    parts = defaultdict(dict)
    for (kind, key), row in scoped.items():
        parts[kind][key] = row
    if definitions:
        # Confirmed definitions are readable even when the selected date contains no instances.
        parts["DEFINITION"] = {key: row for (kind, key), row in rows.items() if kind == "DEFINITION"}
    return adopted, parts


def _observed_pairs(parts):
    definitions = parts["DEFINITION"]
    nodes = parts["NODE"]
    groups = defaultdict(list)
    for edge in parts["EDGE"].values():
        fact = parts["FACT"].get(edge.get("fact_ref"))
        definition = edge.get("definition_ref")
        if not fact or fact.get("state") not in {"ACTIVE", "ADOPTED", "ENDED"} or fact.get("negated") is not False:
            continue
        if definitions.get(definition, {}).get("kind") != "RELATION":
            continue
        a, b = (set(nodes.get(edge[key], {}).get("type_refs") or []) for key in ("source", "target"))
        # A multi-type entity does not establish which type participated.
        if len(a) != 1 or len(b) != 1:
            continue
        domain, range_ = next(iter(a)), next(iter(b))
        if all(definitions.get(key, {}).get("kind") == "TYPE" for key in (domain, range_)):
            groups[definition, domain, range_].append(fact["fact_ref"])
    return groups


def _ontology_graph(reader, library, view, at, focus, cursor, limit):
    adopted, parts = _graph(reader, library, view, at, definitions=True)
    definitions = parts["DEFINITION"]
    require(not focus or focus in definitions, "OBJECT_NOT_IN_VIEW", 404)
    types = {key: dict(id=key, label=row["label"], definition_status=row.get("definition_status"))
             for key, row in definitions.items() if row["kind"] == "TYPE"}
    edges = [dict(id=ref("observed_type_pair", definition, a, b), definition_ref=definition,
                  source=a, target=b, label=definitions[definition]["label"], directed=True,
                  evidence_kind="OBSERVED", instance_count=len(set(facts)))
             for (definition, a, b), facts in sorted(_observed_pairs(parts).items())]
    relevant = [edge for edge in edges if focus in (edge["definition_ref"], edge["source"], edge["target"])]
    relevant_ids = {edge["id"] for edge in relevant}
    first_nodes = {key for edge in relevant for key in (edge["source"], edge["target"])} | {focus}
    ordered = ([("edge", edge) for edge in relevant]
               + [("node", types[key]) for key in sorted(first_nodes & types.keys())]
               + [("edge", edge) for edge in edges if edge["id"] not in relevant_ids]
               + [("node", row) for key, row in sorted(types.items()) if key not in first_nodes])
    revision = adopted["view_revision"]
    items, next_cursor = _page(ordered, digest([library, revision, at, focus, limit, "ui-ontology"]), cursor, limit)
    selected_nodes = {row["id"]: row for kind, row in items if kind == "node"}
    selected_edges = [row for kind, row in items if kind == "edge"]
    for edge in selected_edges:
        for key in ("source", "target"):
            selected_nodes[edge[key]] = types[edge[key]]
    return dict(view_revision=revision, scope=_scope(at), nodes=list(selected_nodes.values()),
                edges=selected_edges, next_cursor=next_cursor, total_nodes=len(types), total_edges=len(edges))


def _definition_instances(reader, library, view, at, definition, cursor, limit):
    adopted, parts = _graph(reader, library, view, at, definitions=True)
    known = parts["DEFINITION"].get(definition)
    require(known, "OBJECT_NOT_IN_VIEW", 404)
    nodes, edges = parts["NODE"], parts["EDGE"]
    if known["kind"] == "TYPE":
        items = [dict(kind="entity", id=key, label=row["label"])
                 for key, row in sorted(nodes.items()) if definition in row.get("type_refs", [])]
    else:
        items = []
        for key, fact in sorted(parts["FACT"].items()):
            if fact["definition_ref"] != definition:
                continue
            edge = edges.get(key)
            source = fact["content"]["subject_ref"]
            items.append(dict(kind="relation" if edge else "knowledge", id=key,
                              label=fact["label"], subject=nodes.get(source, {}).get("label") or fact.get("subject_label"),
                              object=nodes.get(edge["target"], {}).get("label") if edge else None,
                              source_refs=fact.get("source_refs", [])))
    revision = adopted["view_revision"]
    page, next_cursor = _page(items, digest([library, revision, at, definition, limit, "ui-instances"]), cursor, limit)
    return dict(view_revision=revision, scope=_scope(at), items=page, total=len(items), next_cursor=next_cursor)


def _neighborhood(reader, library, view, at, kind, target, limit):
    adopted, parts = _graph(reader, library, view, at)
    nodes, edges = parts["NODE"], parts["EDGE"]
    selected = edges.get(target) if kind == "relation" else nodes.get(target)
    require(selected, "OBJECT_NOT_IN_VIEW", 404)
    centers = {selected["source"], selected["target"]} if kind == "relation" else {target}
    candidates = [row for _, row in sorted(edges.items())
                  if centers.intersection((row["source"], row["target"]))]
    if kind == "relation":
        candidates = [selected, *(row for row in candidates if row["id"] != target)]
    visible_edges = candidates[:limit]
    visible_nodes = centers | {row[endpoint] for row in visible_edges for endpoint in ("source", "target")}
    return dict(view_revision=adopted["view_revision"], scope=_scope(at), publication_status="PUBLISHED",
                coverage=adopted["coverage"], gaps=adopted["gaps"],
                graph=dict(nodes=[nodes[key] for key in sorted(visible_nodes)], edges=visible_edges),
                selection=dict(truncated=len(candidates) > len(visible_edges), next_cursor=None),
                summary=dict(total_nodes=len(nodes), total_edges=len(edges), returned_nodes=len(visible_nodes),
                             returned_edges=len(visible_edges)))


def _fact_detail(reader, library, view, at, fact_ref):
    detail = reader.record(library, "FACT", fact_ref, view, at)
    version = detail.get("fact_version_ref")
    if not version:
        return detail
    with reader.store.transaction(readonly=True) as (q, _):
        row = q("""SELECT fact_revision FROM fact_routing_v1.fact_versions
                   WHERE library_ref=%s AND fact_ref=%s AND fact_version_ref=%s""",
                [library, fact_ref, version]).fetchone()
        if row:
            recorded = next((entry["activated_at"] for entry in confirmed_history(q, library, view)
                             if entry["fact_revision"] == row["fact_revision"]), None)
            detail = dict(detail, recorded_at=recorded)
    return detail


def _source_search(reader, retrieval, actor, library, view, query, cursor, limit):
    require(actor and retrieval, "QUERY_ADAPTER_UNAVAILABLE", 503)
    query = query.strip()
    require(query, "SOURCE_SEARCH_QUERY_REQUIRED", 422)
    scoped = retrieval.open_query_view(library, actor, view_revision=view)
    revision = scoped["view_revision"]
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    filenames = {}
    with retrieval.store.transaction(readonly=True) as (q, _):
        if getattr(reader, "documents", None):
            from ontoweave_product.documents import confirmed_documents

            filenames = {(row["doc_ref"], row["content_sha256"]): row["filename"]
                         for row, _, _, _ in confirmed_documents(q, library, revision)}
        adopted, descriptor = retrieval._bound(q, scoped)
        if descriptor:
            blocks = sources.read(q, library, adopted["source_manifest_ref"])["body"]["blocks"]
        else:
            rows = projection(q, library, revision, ("SOURCE",))
            blocks = [dict(source, title=row.get("title")) for _, row in sorted(rows.items())
                      if (source := graph_source(row))]
    hits, titles = [], set()
    for block in blocks:
        text = block.get("text")
        if not text:
            continue
        document = (block["doc_ref"], block["document_revision"])
        title = filenames.get(document) or block.get("title") or "资料片段"
        match = pattern.search(text)
        title_match = pattern.search(title)
        if not match and (not title_match or document in titles):
            continue
        if title_match:
            titles.add(document)
        start, end = match.span() if match else (0, 0)
        left, right = max(0, start - 55), min(len(text), end + 105)
        hits.append(dict(source_ref=block["source_ref"], title=title, doc_ref=document[0],
                         document_revision=document[1], unit_ref=block.get("unit_ref"), precision=block["precision"],
                         match_kind="TEXT" if match else "TITLE", start=start if match else None,
                         end=end if match else None, snippet=text[left:right], snippet_start=left,
                         quote=match.group() if match else None))
    hits.sort(key=lambda row: (row["match_kind"] != "TITLE", row["title"], row["source_ref"]))
    signature = digest([library, revision, scoped["index_descriptor_ref"], query, limit, "ui-source-search"])
    page, next_cursor = _page(hits, signature, cursor, limit)
    return dict(view_revision=revision, index_descriptor_ref=scoped["index_descriptor_ref"], items=page,
                next_cursor=next_cursor, total=len(hits))


def mount_workbench_reads(router, backend, actor):
    @router.get("/ui/ontology-graph")
    def ontology_graph(library_ref: str, view_revision: str, at: str | None = None, focus: str | None = None,
                       cursor: str | None = None, limit: PageLimit = 100):
        return _ontology_graph(backend(library_ref)["reader"], library_ref, view_revision, at, focus, cursor, limit)

    @router.get("/ui/definitions")
    def definitions(library_ref: str, view_revision: str, query: Annotated[str, Query(max_length=160)] = "",
                    kind: Literal["TYPE", "RELATION", "ATTRIBUTE", "CONSTRAINT"] | None = None,
                    status: str | None = None, cursor: str | None = None, limit: PageLimit = 40):
        with backend(library_ref)["reader"].store.transaction(readonly=True) as (q, _):
            view = _read_view(q, library_ref, view_revision)["view_revision"]
            rows = projection(q, library_ref, view, ("DEFINITION",))
        needle = query.strip().casefold()
        items = [row for _, row in sorted(rows.items())
                 if (not kind or row["kind"] == kind) and (not status or row.get("definition_status") == status)
                 and needle in row["label"].casefold()]
        page, next_cursor = _page(items, digest([library_ref, view, needle, kind, status, limit, "ui-definitions"]),
                                  cursor, limit)
        return dict(view_revision=view, items=page, total=len(items), next_cursor=next_cursor)

    @router.get("/ui/definitions/{definition_ref}/instances")
    def definition_instances(library_ref: str, definition_ref: str, view_revision: str, at: str | None = None,
                             cursor: str | None = None, limit: PageLimit = 40):
        return _definition_instances(backend(library_ref)["reader"], library_ref, view_revision, at,
                                     definition_ref, cursor, limit)

    @router.get("/ui/graph/neighborhood")
    def neighborhood(library_ref: str, view_revision: str, kind: Literal["entity", "relation"], target: str,
                     at: str | None = None, limit: PageLimit = 80):
        return _neighborhood(backend(library_ref)["reader"], library_ref, view_revision, at, kind, target, limit)

    @router.get("/ui/facts/{fact_ref}")
    def fact_detail(library_ref: str, fact_ref: str, view_revision: str, at: str | None = None):
        return _fact_detail(backend(library_ref)["reader"], library_ref, view_revision, at, fact_ref)

    @router.get("/ui/source-search")
    def source_search(library_ref: str, view_revision: str, query: Annotated[str, Query(min_length=1, max_length=160)],
                      cursor: str | None = None, limit: PageLimit = 20):
        selected = backend(library_ref)
        return _source_search(selected["reader"], selected.get("retrieval"), actor, library_ref, view_revision,
                              query, cursor, limit)
