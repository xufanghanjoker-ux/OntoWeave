"""Read-only query business logic. The shared Reader owns qualification and storage."""
from copy import deepcopy
from hashlib import sha256
import json
from threading import RLock
from time import perf_counter
from uuid import uuid4

from ontoweave_retrieval_contracts import (
    SOURCE_HIT_LIMIT, SOURCE_PREVIEW_CODEPOINTS, SOURCE_READ_CODEPOINTS,
)

from .kernel import QueryError
from .tools import TOOLS, tool_definitions, valid_arguments

DEFAULT_PAGE_SIZE = 12
RERANK_WINDOW = 64
READ_TOOLS = {"read_source", "search_sources"}
GRAPH_TOOLS = {
    "get_entity_facts": "graph_entity_facts",
    "expand_graph": "graph_expand",
    "find_paths": "graph_paths",
}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return sha256(_json(value).encode()).hexdigest()


def _state(value):
    return value in {"READY", "READY_EMPTY", "PARTIAL", "LEXICAL", "HYBRID"}


def _overlaps(a, b):
    return (all(a[k] == b[k] for k in ("doc_ref", "document_revision", "parent_block_ref"))
            and max(a["start"], b["start"]) < min(a["end"], b["end"]))


def _eligible(member):
    return member["temporal_eligibility"] != "EXCLUDED"


def _source_matches(record, scopes):
    return not scopes or any(
        scopes.intersection((source["source_ref"], source["doc_ref"])) for source in record["source_refs"])


def _text_range(source, text=None):
    span = dict(start=source["start"], end=source["end"], block_ref=source["parent_block_ref"],
                offset_unit="unicode_codepoint", mapping_precision=source["precision"])
    if text is not None:
        span.update(quote=text, quote_chars=len(text), passage_text_verified=True)
    return span


class QueryService:
    def __init__(self, reader, kernel, *, embedding_client=None, rerank=None):
        self.reader = reader
        self.kernel = kernel
        self.embedding_client = embedding_client
        self.rerank = rerank

    def open(self, library_ref, authorization_scope, **selection):
        view = self.reader.open_query_view(library_ref, authorization_scope, **selection)
        return QueryTurn(self, view)

    def verify(self, view):
        verify = getattr(self.reader, "verify_query_view", None)
        if verify is not None:
            verify(view)
        else:
            self.reader.load_index_descriptor(view)
        return True


class QueryTurn:
    def __init__(self, service, view):
        self.service = service
        self.reader = service.reader
        self.kernel = service.kernel
        self.view = deepcopy(view)
        self.descriptor = self.reader.load_index_descriptor(self.view)
        self.lock = RLock()
        self.cursors = {}
        self.cursor_tokens = {}
        self.refs = {"entity": {}, "source": {}}
        self.lookup = {"entity": {}, "source": {}}
        self.source_scopes = {}
        self.source_titles = {}
        self.issued = {"entity": set(), "source": set()}
        self.progress = set()
        self.delivered_source_ranges = set()
        self.ranking = []
        components = self.view["capabilities"]
        names = set()
        if _state(components.get("source_lexical")):
            names.update(READ_TOOLS)
        if _state(components.get("knowledge_lexical")):
            names.add("search_knowledge")
        if _state(components.get("entity_name")):
            names.add("find_entities")
            if self.view.get("graph_revision") and _state(components.get("knowledge_lexical")):
                names.update(GRAPH_TOOLS)
        self.names = names

    def inventory(self):
        return tool_definitions(self.names)

    def verify(self):
        return self.service.verify(self.view)

    def _short(self, category, value):
        refs = self.refs[category]
        if value not in refs:
            token = f"{category[0].upper()}{len(refs) + 1:03d}"
            refs[value] = token
            self.lookup[category][token] = value
        return refs[value]

    def _cursor(self, name, kind, value, key):
        identity = (name, kind, _digest(key))
        existing = self.cursor_tokens.get(identity)
        if existing is not None:
            return existing
        token = "page_" + uuid4().hex
        self.cursor_tokens[identity] = token
        self.cursors[token] = (name, kind, value)
        return token

    def _sources(self, args):
        return {self.source_scopes.get(ref, self.lookup["source"].get(ref, ref))
                if ref in self.issued["source"] else ref for ref in args.get("source_refs", [])}

    def _members(self, pool, args, *, vectors=False):
        scopes = self._sources(args)
        return [member for member in self.reader.load_retrieval_records(self.view, pool, include_vectors=vectors)
                if _eligible(member) and _source_matches(member["record"], scopes)]

    def _rank(self, pool, args, operation_ref):
        started = perf_counter()
        members = self._members(pool, args, vectors=True)
        by_ref = {m["record"]["record_version_ref"]: m for m in members}
        if len(by_ref) != len(members):
            raise QueryError("QUERY_RECORD_MEMBERSHIP_DUPLICATE")
        space = self.reader.load_embedding_space(self.view, pool)
        rows = []
        for key, m in by_ref.items():
            record = m["record"]
            text = record["text_for_search"]
            if sha256(text.encode()).hexdigest() != record["text_sha256"]:
                raise QueryError("QUERY_RECORD_TEXT_MISMATCH")
            row = dict(record_ref=key, search_text=text)
            vector = m.get("vector")
            if vector is not None:
                if (space is None or space["space_ref"] != m.get("space_ref")
                        or space["space_ref"] != self.view["space_refs"].get(pool)
                        or pool not in space["document_profile_refs"]):
                    raise QueryError("QUERY_RECORD_SPACE_MISMATCH")
                row["embedding"] = dict(space_ref=space["space_ref"], values=vector)
            rows.append(row)
        available = any("embedding" in row for row in rows)
        client = self.service.embedding_client
        prepared = self.kernel("search_prepare", dict(
            rows=rows, args={"query": args["query"]}, type="sources" if pool == "SOURCE" else "facts",
            scope={"embedding_spaces": [dict(space_ref=space["space_ref"], model=space["model"],
                                            dimensions=space["dimensions"], distance=space["distance_metric"])]
                   if available else []},
            embedding_enabled=available and client is not None,
        ))
        vectors = []
        embedding_start = perf_counter()
        if prepared["groups"] and client is not None:
            vector = self.reader.load_query_vector(self.view, pool, args["query"], client=client,
                                                   operation_ref=operation_ref)
            vectors.append(dict(space_ref=space["space_ref"], values=vector))
        embedding_ms = (perf_counter() - embedding_start) * 1000 if vectors else None
        ranked = self.kernel("search_finish", dict(prepared=prepared, query_vectors=vectors))
        refs = [row["record_ref"] for row in ranked["rows"]]
        rerank_ms = None
        if self.service.rerank is not None and refs:
            candidates = refs[:RERANK_WINDOW]
            documents = [by_ref[ref]["record"]["text_for_search"] for ref in candidates]
            rerank_start = perf_counter()
            order = self.service.rerank(args["query"], documents, operation_ref=operation_ref)
            rerank_ms = (perf_counter() - rerank_start) * 1000
            if (not isinstance(order, list) or len(order) != len(candidates)
                    or any(type(index) is not int for index in order)
                    or set(order) != set(range(len(candidates)))):
                raise QueryError("QUERY_RERANK_ORDER_INVALID")
            refs = [candidates[index] for index in order] + refs[RERANK_WINDOW:]
        capability = ranked["capability"]
        if ranked["mode"] == "HYBRID":
            if any(m.get("vector") is None for m in members):
                capability = "PARTIAL_HYBRID"
        elif available and client is None:
            capability = "LEXICAL_QUERY_EMBEDDING_UNAVAILABLE"
        trace = dict(pool=pool, mode=ranked["mode"], capability=capability, candidates=len(members),
                     rerank_enabled=self.service.rerank is not None, ranking_revision=ranked["ranking_revision"])
        self.ranking.append({**trace, "retrieval_ms": (perf_counter() - started) * 1000,
                             "query_vector_read_or_compute_ms": embedding_ms, "rerank_ms": rerank_ms})
        return [by_ref[ref] for ref in refs], trace

    def _target(self, source, text=None, title=None):
        return dict(doc_ref=source["doc_ref"], revision=source["document_revision"],
                    title=title or source["doc_ref"], precision=source["precision"],
                    source_snapshot_ref=(self.descriptor or {}).get("source_manifest_ref"),
                    source_ref=source["source_ref"], block_ref=source["parent_block_ref"],
                    offset_unit="unicode_codepoint", spans=[_text_range(source, text)])

    def _citation(self, kind, representation, targets, identity, label=None):
        return dict(citation_ref="query_citation_" + _digest([self.view["business_manifest_ref"],
                    self.view.get("retrieval_index_revision"), self.view["at"], self.view["as_of"],
                    kind, identity, targets]), kind=kind, representation=representation,
                    label=label, source_targets=targets)

    def _source_row(self, page, title=None):
        segment = page["source_segment_ref"]
        ranges = page["delivered_ranges"]
        if not ranges or len(page["text"]) != sum(r["end"] - r["start"] for r in ranges):
            raise QueryError("QUERY_SOURCE_RANGE_MISMATCH")
        targets, offset = [], 0
        for source in ranges:
            length = source["end"] - source["start"]
            targets.append({**self._target(source, page["text"][offset:offset + length], title),
                            "source_segment_ref": segment})
            offset += length
        citation = self._citation("SOURCE", "VERBATIM_SOURCE", targets, segment, title)
        continuation = page["next_cursor"]
        if page["truncated"] != bool(continuation):
            raise QueryError("QUERY_SOURCE_CURSOR_MISMATCH")
        token = self._cursor("read_source", "source", (segment, continuation, title),
                             [segment, [(r["start"], r["end"]) for r in ranges]]) if continuation else None
        model_ranges = [{key: r[key] for key in ("start", "end", "offset_unit", "precision")} for r in ranges]
        short = self._short("source", segment)
        self.source_scopes[short] = ranges[0]["doc_ref"]
        row = dict(text=page["text"], title=title, representation="SOURCE",
                   source=short, delivered_ranges=model_ranges,
                   truncated=page["truncated"], next_cursor=token,
                   citation_ref=citation["citation_ref"])
        return row, [citation]

    def _source_page(self, members, args, trace, start=0, delivered=()):
        items, citations = [], []
        seen = list(delivered)
        limit = min(args.get("page_size", SOURCE_HIT_LIMIT), SOURCE_HIT_LIMIT)
        index = start
        while index < len(members) and len(items) < limit:
            member = members[index]
            record = member["record"]
            index += 1
            page = self.reader.load_source_range(self.view, record["source_segment_ref"],
                                                 limit=SOURCE_PREVIEW_CODEPOINTS)
            if len(page["text"]) > SOURCE_PREVIEW_CODEPOINTS:
                raise QueryError("QUERY_SOURCE_PREVIEW_BUDGET_EXCEEDED")
            if any(_overlaps(a, b) for a in page["delivered_ranges"] for b in seen):
                continue
            row, refs = self._source_row(page, record["content"].get("title"))
            items.append(row)
            citations.extend(refs)
            seen.extend(page["delivered_ranges"])
        cursor = self._cursor("search_sources", "source_search", (members, args, trace, index, seen),
                              [args, index]) if index < len(members) else None
        return self._result(items, citations, cursor, **trace)

    def _read(self, segment, cursor=None, title=None):
        page = self.reader.load_source_range(self.view, segment, cursor=cursor,
                                             limit=SOURCE_READ_CODEPOINTS)
        if len(page["text"]) > SOURCE_READ_CODEPOINTS:
            raise QueryError("QUERY_SOURCE_READ_BUDGET_EXCEEDED")
        row, refs = self._source_row(page, title)
        return self._result([row], refs, row["next_cursor"], read_scope="PARENT_BLOCK")

    def _read_requested(self, source):
        actual = self.lookup["source"].get(source, source) if source in self.issued["source"] else source
        if source in self.issued["source"] and actual in self.source_titles:
            return self._read(actual, title=self.source_titles[actual])
        exact, docs = [], {}
        for member in self._members("SOURCE", {}):
            record = member["record"]
            segment = record["source_segment_ref"]
            title = record["content"].get("title")
            if segment == actual:
                exact.append((member, title))
            for location in record["source_refs"]:
                if actual in (location["source_ref"], location["doc_ref"], title):
                    key = location["doc_ref"], location["document_revision"]
                    docs.setdefault(key, []).append((member, title, location))
        if len(exact) == 1:
            return self._read(exact[0][0]["record"]["source_segment_ref"], title=exact[0][1])
        if not docs:
            return self._result([], [])
        if len(docs) > 1:
            return self._result([dict(title=members[0][1], source=self._short("source", key[0]))
                                 for key, members in sorted(docs.items())[:DEFAULT_PAGE_SIZE]], [],
                                status="AMBIGUOUS", truncated=len(docs) > DEFAULT_PAGE_SIZE)
        candidates = next(iter(docs.values()))
        member, title, _ = min(candidates, key=lambda entry: (entry[2]["parent_block_ref"], entry[2]["start"]))
        return self._read(member["record"]["source_segment_ref"], title=title)

    def _knowledge(self, member, content=None):
        record = member["record"]
        body = record["content"] if content is None else content
        targets = [self._target(source) for source in record["source_refs"]]
        citation = self._citation("GRAPH", "EXTRACTED_KNOWLEDGE", targets, record["object_version_ref"],
                                  body.get("label"))
        citation.update(record_representation=record["representation"], knowledge_refs=[record["object_ref"]])
        row = dict(representation=record["representation"], state=record["state"],
                   temporal_eligibility=member["temporal_eligibility"], content=_knowledge_body(body))
        if record["entity_refs"]:
            row["entities"] = [self._short("entity", ref) for ref in record["entity_refs"]]
        if targets:
            row["citation_ref"] = citation["citation_ref"]
            row["sources"] = []
            for target in targets:
                key = target["source_ref"]
                short = self._short("source", key)
                self.source_titles[key] = target["title"]
                self.source_scopes[short] = target["doc_ref"]
                row["sources"].append(dict(source=short, title=target["title"], precision=target["precision"]))
        return row, [citation] if targets else []

    def _bounded(self, name, rows, args, meta, start=0):
        limit = args.get("page_size", DEFAULT_PAGE_SIZE)
        items, citations = [], []
        used, index = 0, start
        while index < len(rows) and len(items) < limit:
            row, refs = rows[index]
            body_length = len(_json(row))
            if body_length > SOURCE_READ_CODEPOINTS:
                if items:
                    break
                token = self._cursor(name, "long", (row, refs, 0), [row, 0])
                items.append(dict(status="RECORD_REQUIRES_PAGES", representation=row.get("representation"),
                                  complete=False, record_cursor=token))
                index += 1
                continue
            if used + body_length > SOURCE_READ_CODEPOINTS:
                break
            used += body_length
            items.append(row)
            citations.extend(refs)
            index += 1
        cursor = self._cursor(name, "rows", (rows, args, meta, index), [args, index, [r for r, _ in rows]]) if index < len(rows) else None
        return self._result(items, citations, cursor, **meta)

    def _long(self, name, row, refs, start):
        # A part is explicitly incomplete. The assembled parts are the original
        # structured result including qualifiers, rather than separately ranked claims.
        identity = _digest(row)
        serialized = _json(row)
        end = min(start + SOURCE_READ_CODEPOINTS, len(serialized))
        cursor = self._cursor(name, "long", (row, refs, end), [row, end]) if end < len(serialized) else None
        item = dict(status="RECORD_PART", complete=False, record=identity,
                    text=serialized[start:end], start=start, end=end, total=len(serialized),
                    offset_unit="UNICODE_CODEPOINT")
        if cursor is None:
            item["citation_refs"] = [citation["citation_ref"] for citation in refs]
        return self._result([item], refs if cursor is None else [], cursor, status="PARTIAL")

    def _result(self, items, citations, cursor=None, **meta):
        unique = {c["citation_ref"]: c for c in citations}
        value = dict(status="READY" if items else "NO_MATCH", items=items,
                     next_cursor=cursor, truncated=bool(cursor))
        value.update(meta)
        return value, list(unique.values())

    def _continue(self, name, token):
        cursor = self.cursors.get(token)
        if cursor is None or cursor[0] != name:
            raise QueryError("QUERY_CURSOR_NOT_ISSUED", recoverable=True)
        _, kind, value = cursor
        if kind == "source":
            return self._read(*value)
        if kind == "source_search":
            return self._source_page(*value)
        if kind == "long":
            return self._long(name, *value)
        return self._bounded(name, *value)

    def _issue_visible(self, node):
        if isinstance(node, list):
            for item in node:
                self._issue_visible(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key == "entity_ref" and isinstance(value, str) and value in self.lookup["entity"]:
                    self.issued["entity"].add(value)
                elif key == "entities" and isinstance(value, list):
                    self.issued["entity"].update(ref for ref in value if isinstance(ref, str) and ref in self.lookup["entity"])
                elif key == "source" and isinstance(value, str) and value in self.lookup["source"]:
                    self.issued["source"].add(value)
                elif isinstance(value, (list, dict)):
                    self._issue_visible(value)

    def call(self, name, args, *, operation_ref):
        with self.lock:
            self.verify()
            if name not in self.names:
                raise QueryError("QUERY_TOOL_UNAVAILABLE")
            signature = _digest([name, args])
            if signature in self.progress:
                return dict(result=dict(status="NO_NEW_INFORMATION", items=[], next_cursor=None,
                                        guidance="这个读取已交付过相同范围。请使用已有证据。"), citations=[])
            self.progress.add(signature)
            if not valid_arguments(name, args):
                return dict(result=dict(status="INVALID_ARGUMENTS", retrieval_executed=False,
                                        guidance="按工具参数使用已给出的查询、引用或单个游标。"), citations=[])
            try:
                value, citations = self._execute(name, args, operation_ref)
            except QueryError as exc:
                if not exc.recoverable:
                    raise
                value, citations = dict(status="INVALID_ARGUMENTS", retrieval_executed=False,
                                        guidance="使用本轮已返回的对应引用或游标。"), []
            self.verify()
            if name in READ_TOOLS and self._repeated_source_page(value, citations):
                return dict(result=dict(status="NO_NEW_INFORMATION", items=[],
                                        guidance="这些原文范围已交付。请使用已有证据。"), citations=[])
            self._issue_visible(value.get("items", []))
            return dict(result=value, citations=citations, diagnostics=self.ranking[-1:] if
                        name in {"search_sources", "search_knowledge"} and "cursor" not in args else [])

    def _repeated_source_page(self, result, citations):
        ranges = {_digest([target["doc_ref"], target["revision"], target["block_ref"], span])
                  for citation in citations for target in citation["source_targets"]
                  for span in target["spans"]}
        if not ranges:
            return False
        next_tokens = [result.get("next_cursor"), *(item.get("next_cursor") for item in result["items"])]
        unread = any(token and _digest([self.cursors[token][0], {"cursor": token}]) not in self.progress
                     for token in next_tokens)
        repeated = ranges <= self.delivered_source_ranges and not unread
        self.delivered_source_ranges.update(ranges)
        return repeated

    def _execute(self, name, args, operation_ref):
        if "cursor" in args:
            return self._continue(name, args["cursor"])
        if name == "read_source":
            return self._read_requested(args["source"])
        if name == "search_sources":
            members, trace = self._rank("SOURCE", args, operation_ref)
            return self._source_page(members, args, trace)
        if name == "search_knowledge":
            members, trace = self._rank("KNOWLEDGE", args, operation_ref)
            graph = self.reader.load_graph(self.view)
            names = {row["subject_ref"]: row["surface"] for row in self._subjects(graph)}
            unique = {}
            for member in members:
                record = member["record"]
                key = record["representation"], record["object_version_ref"]
                unique.setdefault(key, member)
            rows = []
            for member in unique.values():
                row, citations = self._knowledge(member)
                facts = self._graph_record(graph, member, names)
                if facts:
                    self._edge_names(row, facts, names)
                rows.append((row, citations))
            return self._bounded(name, rows, args, trace)
        graph = self.reader.load_graph(self.view)
        if name == "find_entities":
            return self._entities(graph, args)
        return self._graph(name, graph, args)

    def _subjects(self, graph):
        return [dict(subject_ref=ref, surface=row["label"], aliases=row.get("aliases", []),
                     types=[(graph.get(("DEFINITION", label)) or {}).get("label") or label
                            for label in row.get("type_refs", [])],
                     state="PENDING" if row.get("pending") else None)
                for (kind, ref), row in sorted(graph.items()) if kind == "NODE"]

    def _entities(self, graph, args):
        input_data = self.kernel("entity_prepare", dict(args={"query": args["query"]},
                                                         subjects=self._subjects(graph)))
        prepared = self.kernel("search_prepare", dict(args=input_data["args"], rows=input_data["rows"],
                                                       scope={}, type="entities", embedding_enabled=False))
        output = self.kernel("search_finish", dict(prepared=prepared, query_vectors=[]))
        rows = [(self._entity(row), []) for row in output["rows"]]
        status = {"status": "AMBIGUOUS"} if input_data["exact_ambiguous"] else {}
        return self._bounded("find_entities", rows, args, status)

    def _entity(self, row):
        return dict(entity_ref=self._short("entity", row["subject_ref"]), name=row["surface"],
                    aliases=row["aliases"], types=row["types"], state=row["state"],
                    exact_match=row.get("exact_match", False))

    def _resolve_entity(self, token):
        actual = self.lookup["entity"].get(token)
        if actual is None or token not in self.issued["entity"]:
            raise QueryError("QUERY_ENTITY_NOT_ISSUED", recoverable=True)
        return actual

    def _graph(self, name, graph, args):
        subjects = self._subjects(graph)
        names = {row["subject_ref"]: row["surface"] for row in subjects}
        records = {}
        for member in self._members("KNOWLEDGE", args):
            record = member["record"]
            records.setdefault(record["object_ref"], member)
        rows = []
        for key, member in records.items():
            fact = self._graph_record(graph, member, names)
            if fact:
                rows.append(fact)
        params = {key: args[key] for key in ("max_depth", "direction") if key in args}
        if name == "find_paths":
            for key in ("from_ref", "to_ref"):
                params[key] = self._resolve_entity(args[key])
        else:
            entity = self._resolve_entity(args["entity_ref"])
            if name == "expand_graph":
                params["seed_refs"] = [entity]
            else:
                params["entity_ref"] = entity
        hint = args.get("relation")
        matched = self._relation_labels(graph, rows, hint)
        if matched:
            params["predicates"] = matched
        output = self.kernel(GRAPH_TOOLS[name], dict(args=params, facts=rows, subjects=subjects))
        if output.get("unavailable"):
            return self._result([], [])
        page = []
        for item in output["items"]:
            if name != "find_paths":
                row, citations = self._knowledge(records[item["fact_ref"]])
                self._edge_names(row, item, names)
                page.append((row, citations))
                continue
            steps, citations = [], []
            for step in item["steps"]:
                fact = step["fact"]
                row, refs = self._knowledge(records[fact["fact_ref"]])
                self._edge_names(row, fact, names)
                steps.append(dict(evidence=row, from_ref=self._short("entity", step["from_ref"]),
                                  to_ref=self._short("entity", step["to_ref"]),
                                  reversed=step["traversal_reversed"]))
                citations.extend(refs)
            definite = all(step["evidence"]["temporal_eligibility"] in {"UNFILTERED", "DEFINITE"} for step in steps)
            page.append((dict(steps=steps, all_edges_time_qualified=definite, nodes=[dict(entity_ref=self._short("entity", ref), name=names[ref])
                                                  for ref in item["nodes"]]), citations))
        meta = {key: value for key, value in output["metadata"].items()
                if key in ("direction", "max_depth", "search_truncated", "coverage")}
        if hint and not matched:
            meta["relation_resolution"] = "UNMAPPED_HINT_UNFILTERED"
        if meta.get("search_truncated"):
            meta["status"] = "PARTIAL"
        return self._bounded(name, page, args, meta)

    def _edge_names(self, row, fact, names):
        for prefix, key in (("subject", "subject_ref"), ("object", "object_ref")):
            if fact.get(key) in names:
                entity = fact[key]
                row[prefix] = dict(entity_ref=self._short("entity", entity), name=names[entity])
        if fact["kind"] == "RELATION":
            row["relation"] = fact["predicate"]
            row["direction"] = "SUBJECT_TO_OBJECT"

    @staticmethod
    def _graph_record(graph, member, names):
        record = member["record"]
        key = record["object_ref"]
        fact = graph.get(("FACT", key), {})
        edge = graph.get(("EDGE", key), {})
        if edge.get("source") in names and edge.get("target") in names:
            return dict(fact_ref=key, subject_ref=edge["source"], object_ref=edge["target"],
                        kind="RELATION", predicate=edge["label"], definition_ref=edge.get("definition_ref"))
        subject = (fact.get("content") or {}).get("subject_ref")
        if subject in names and (fact["content"].get("value") or {}).get("kind") != "ENTITY":
            return dict(fact_ref=key, subject_ref=subject, kind="ATTRIBUTE",
                        attribute=fact.get("label"), definition_ref=fact.get("definition_ref"))
        # An OPEN text with no authenticated endpoints remains searchable as text.
        return None

    @staticmethod
    def _relation_labels(graph, rows, hint):
        if not hint:
            return []
        target = hint.strip().casefold()
        matched = set()
        for row in rows:
            definition = graph.get(("DEFINITION", row.get("definition_ref")), {})
            label = row.get("predicate") or row.get("attribute")
            labels = [label, definition.get("label"), definition.get("name"), *definition.get("aliases", [])]
            for binding in definition.get("bindings", []):
                labels.extend(binding.get(key) for key in ("label", "surface", "raw_label", "alias"))
            if label and any(isinstance(value, str) and value.strip().casefold() == target for value in labels):
                matched.add(label)
        return sorted(matched)


def _knowledge_body(row):
    if "content" in row and isinstance(row["content"], dict):
        body = {key: row[key] for key in ("label", "subject_label", "world_time", "world_time_raw", "modality", "negated")
                if key in row}
        content = row["content"]
        body.update({key: content[key] for key in ("qualifiers", "attribution", "modality", "negated",
                                                   "conditions", "exceptions", "unit", "rule_text", "participants")
                     if key in content})
        value = content.get("value")
        if isinstance(value, dict) and value.get("kind") != "ENTITY":
            body["value"] = value
        return body or _visible_body(content)
    if isinstance(row.get("candidate"), dict):
        candidate = row["candidate"]
        fields = ("subject", "object", "relation_phrase", "predicate", "value_raw", "unit", "qualifiers",
                  "times", "world_time", "negation", "negated", "modality", "attribution", "conditions",
                  "exceptions", "rule_text", "participants", "kind")
        body = {key: candidate[key] for key in fields if key in candidate}
        if (row.get("record") or {}).get("raw_utf8") is not None:
            body["statement"] = row["record"]["raw_utf8"]
        return body
    return _visible_body(row)


def _visible_body(row):
    fields = ("text", "statement", "predicate", "attribute", "subject", "object", "value", "unit",
              "conditions", "qualifiers", "negation", "negated", "modality", "exceptions", "world_time",
              "time_text", "version_text", "attribution", "rule_text", "kind")
    return {key: row[key] for key in fields if key in row}


class QueryRegistry:
    """Process-local turn state behind the trusted service-to-service API."""

    def __init__(self, service):
        self.service = service
        self.turns = {}
        self.lock = RLock()

    def dispatch(self, library_ref, authorization_scope, action, body):
        if action == "open":
            selection = {key: body[key] for key in ("at", "as_of", "view_revision", "index_descriptor_ref")
                         if key in body}
            turn = self.service.open(library_ref, authorization_scope, **selection)
            view = {key: value for key, value in turn.view.items() if key != "authorization_scope"}
            return dict(view=view, definitions=turn.inventory(),
                        source_manifest_ref=(turn.descriptor or {}).get("source_manifest_ref"))
        supplied = body.get("view")
        if not isinstance(supplied, dict) or supplied.get("library_ref") != library_ref:
            raise QueryError("QUERY_LIBRARY_BINDING_INVALID")
        view = {**supplied, "authorization_scope": authorization_scope}
        if action != "close":
            self.service.verify(view)
        if action == "verify":
            return dict(verified=True)
        query_id = body.get("query_id")
        if not isinstance(query_id, str) or not query_id:
            raise QueryError("QUERY_TURN_REF_REQUIRED")
        key = (library_ref, query_id)
        with self.lock:
            turn = self.turns.get(key)
            if turn is not None and turn.view != view:
                raise QueryError("QUERY_TURN_VIEW_MISMATCH")
            if action == "close":
                self.turns.pop(key, None)
                return dict(closed=True)
            if action != "call":
                raise QueryError("QUERY_INTERNAL_ACTION_UNKNOWN")
            if turn is None:
                turn = QueryTurn(self.service, view)
                self.turns[key] = turn
        return turn.call(body.get("name"), body.get("args", {}), operation_ref=body["operation_ref"])
