"""Deterministic retrieval material derived from a target graph and source inventory."""
from collections import Counter
from hashlib import sha256

from ontoweave_publication.store import digest, ref, require
from ontoweave_retrieval_contracts import OFFSET_UNIT

RENDER_VERSIONS = dict(SOURCE="parsed-block/1", FACT="fact-business-text/1", OPEN="open-statement/1")
INDEX_COMPONENTS = ("entity_name", "source_lexical", "source_vector", "knowledge_lexical", "knowledge_vector")


def text_sha(text):
    return sha256(text.encode("utf-8")).hexdigest()


def binding(publication, graph, inventory_sha):
    return digest(dict(source_manifest_ref=publication["source_manifest_ref"],
                       target_revisions=publication["target_revisions"], source_inventory_sha256=inventory_sha,
                       graph=[[kind, key, row] for (kind, key), row in sorted(graph.items())]))


def locator(source, end, start=0):
    return dict(source_ref=source["source_ref"], doc_ref=source["doc_ref"],
                document_revision=source.get("document_revision") or source["revision"],
                parent_block_ref=source.get("parent_block_ref") or source.get("chunk_ref") or source["unit_ref"],
                unit_ref=source.get("unit_ref"), start=start, end=end, offset_unit=OFFSET_UNIT,
                precision=source["precision"])


def graph_source(row):
    text = row.get("text")
    if not isinstance(text, str) or not text or not row.get("doc_ref") or not row.get("revision"):
        return None
    require(not row.get("text_sha256") or row["text_sha256"] == text_sha(text), "INDEX_SOURCE_BYTES_CHANGED", 503)
    return dict(text=text, **locator(row, len(text)))


def _value(value, names):
    if isinstance(value, dict):
        if value.get("entity_ref"):
            return names.get(value["entity_ref"], value["entity_ref"])
        if value.get("kind") == "VALUE":
            return " ".join(filter(None, (_value(value.get(field), names) for field in ("value", "unit"))))
        return " ".join(f"{key} {_value(item, names)}" for key, item in sorted(value.items()) if item is not None)
    if isinstance(value, list):
        return "；".join(_value(item, names) for item in value)
    if isinstance(value, bool):
        return "是" if value else "否"
    return "" if value is None else str(value)


def _knowledge(kind, row, edge, names):
    if kind == "FACT":
        content = row["content"]
        subject = content["subject_ref"]
        value = content["value"]
        terms = [names.get(subject) or row.get("subject_label"), row["label"], value, row.get("raw_properties")]
        terms += [f"否定 {_value(content.get('negated'), names)}", content.get("modality"), content.get("attribution"),
                  content.get("conditions"), content.get("qualifiers"), row.get("world_time"), row.get("world_time_raw")]
        entities = [subject, value.get("entity_ref")]
        definitions = [row["definition_ref"]]
        temporal = {field: row.get(field) for field in ("world_time", "world_time_raw")}
    else:
        candidate = row.get("candidate") or {}
        subject, obj = edge.get("source"), edge.get("target")
        terms = [names.get(subject) or candidate.get("subject"),
                 candidate.get("relation_phrase") or candidate.get("predicate"),
                 names.get(obj) or candidate.get("value_raw"), candidate.get("unit"),
                 (row.get("record") or {}).get("raw_utf8"), candidate.get("qualifiers"),
                 candidate.get("times"), candidate.get("modality"), candidate.get("attribution")]
        entities, definitions = [subject, obj], []
        temporal = {field: candidate[field] for field in ("times", "world_time") if field in candidate}
    text = "\n".join(dict.fromkeys(piece for term in terms if (piece := _value(term, names).strip())))
    return text, sorted(set(filter(None, entities))), definitions, temporal


def _record(library, kind, object_ref, object_version, search, sources, *, entities=(), definitions=(),
            state=None, temporal=None, content, parent=None, source_segment=None):
    record = dict(record_ref=ref("retrieval_record", library, kind, object_ref, parent, source_segment),
                  library_ref=library, pool="SOURCE" if kind == "SOURCE" else "KNOWLEDGE", representation=kind,
                  object_ref=object_ref, object_version_ref=object_version, parent_record_ref=parent,
                  text_for_search=search, text_sha256=text_sha(search), render_version=RENDER_VERSIONS[kind],
                  source_refs=sources, entity_refs=list(entities), definition_refs=list(definitions), state=state,
                  temporal_refs=temporal or {}, content=content, source_segment_ref=source_segment)
    return dict(record, record_version_ref=ref("retrieval_record_version", record))


def materials(library, graph, blocks, segment_size):
    records, expected, gaps = [], Counter(), {kind: [] for kind in RENDER_VERSIONS}
    for block in blocks:
        key = block["source_ref"]
        expected["SOURCE"] += 1
        text = block["text"]
        if not text or not text.strip():
            gaps["SOURCE"].append(dict(object_ref=key, code=block.get("gap") or "SOURCE_BLOCK_UNREADABLE"))
            continue
        version = ref("source_object_version", key, block["document_revision"], block["text_sha256"])
        parent = ref("retrieval_record", library, "SOURCE", key, None, None)
        for start in range(0, len(text), segment_size):
            end = min(len(text), start + segment_size)
            range_ref = locator(block, end, start)
            segment = ref("source_segment", library, version, range_ref)
            records.append(_record(library, "SOURCE", key, version, text[start:end], [range_ref],
                                   parent=parent, source_segment=segment,
                                   content=dict(title=block.get("title"), body_range=range_ref)))
    names = {key: row["label"] for (kind, key), row in graph.items() if kind == "NODE"}
    links = {}
    for (kind, key), row in graph.items():
        if kind == "SOURCE" and (available := graph_source(row)):
            links[key] = {field: value for field, value in available.items() if field != "text"}
    for (kind, key), row in sorted(graph.items()):
        if kind != "FACT" and (kind != "STATEMENT" or row.get("routing_result") != "OPEN_UNINTERPRETED"):
            continue
        representation = "FACT" if kind == "FACT" else "OPEN"
        expected[representation] += 1
        search, entities, definitions, temporal = _knowledge(kind, row, graph.get(("EDGE", key), {}), names)
        if not search:
            gaps[representation].append(dict(object_ref=key, code="KNOWLEDGE_TEXT_UNREADABLE"))
            continue
        sources = [links[source] for source in row.get("source_refs", []) if source in links]
        state = row.get("state") if kind == "FACT" else row["routing_result"]
        parent = ref("retrieval_record", library, representation, key, None, None)
        for offset in range(0, len(search), segment_size):
            records.append(_record(library, representation, key,
                                   row.get("fact_version_ref") or ref("open_object_version", row),
                                   search[offset:offset + segment_size], sources, state=state, temporal=temporal,
                                   entities=entities, definitions=definitions,
                                   content=dict(row, search_range=[offset, min(len(search), offset + segment_size)]),
                                   parent=parent if len(search) > segment_size else None,
                                   source_segment=None))
    return records, expected, gaps
