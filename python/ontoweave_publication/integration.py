"""Project outputs from explicit identity, ontology and Rust fact revisions."""
from collections import Counter, defaultdict

from ontoweave_facts import INPUT, RULE_VERSION, verify
from ontoweave_facts.input import identity_statements
from ontoweave_facts.local import restore_statement_annotations
from ontoweave_facts.preview import intent_group_keys, preview_fact_intent
from ontoweave_facts.repository import read_fact_snapshot
from ontoweave_facts.routing import EMPTY_BASE, assemble_bundle, base_time_alternatives, fold_plan, group_keys_for, prepare_routing
from ontoweave_ontology.repository import OntologyRepository
from ontoweave_ontology.signatures import source_ref
from ontoweave_ontology.source import load_identity

from .coordinator import GRAPH_KINDS, INDEX_KINDS, _diff, _validate_graph, _validate_index
from .store import digest, head, manifest, projection, ref, require, review_rows


def confirmed_history(q, library, view):
    rows = q("""WITH RECURSIVE lineage AS (
                    SELECT view_revision,parent_view_revision,body,activation_seq
                    FROM publication_v1.manifests WHERE library_ref=%s AND view_revision=%s
                    UNION ALL
                    SELECT m.view_revision,m.parent_view_revision,m.body,m.activation_seq
                    FROM publication_v1.manifests m JOIN lineage l ON m.view_revision=l.parent_view_revision
                    WHERE m.library_ref=%s
                ) SELECT l.body->>'fact_revision' AS fact_revision, l.activation_seq,c.activated_at
                  FROM lineage l JOIN publication_v1.confirmations c USING (view_revision)
                  WHERE c.library_ref=%s ORDER BY activation_seq DESC""", [library, view, library, library]).fetchall()
    by_revision = {item["fact_revision"]: dict(item, activated_at=item["activated_at"].isoformat()) for item in rows}
    return list(by_revision.values())


def _sources(row):
    return [{**item, "source_ref": source_ref(item)} for item in row["source_refs"]]


def routing_statements(identity, annotations=None):
    rows = identity_statements(identity, annotations)
    for key, row in rows.items():
        row["source_refs"] = _sources(identity["statements"][key])
        retained = (annotations or {}).get(key, {}).get("retained_timezone_hints")
        if retained:
            row["retained_timezone_hints"] = retained
    return rows


def routing_request(library, operation, adopted, identity, ontology, time, source, statements, trigger):
    return dict(contract=INPUT, library_ref=library, operation_ref=operation, trigger=trigger,
                base_view_revision=adopted and adopted["view_revision"], identity_revision=identity,
                ontology_alignment_ref=ontology, time_revision=time, source_manifest_ref=source,
                statement_refs=sorted(statements), constraint_refs=[])


def read_routing_base(q, library, history, adopted, groups, statements=()):
    return read_fact_snapshot(q, library, history, {
        "activation_ref": adopted and adopted["view_revision"], "activation_seq": (adopted or {}).get("activation_seq", 0)
    }, group_keys=groups, statement_refs=statements)


def prepare_initial_bundle(store, engine, request):
    library = request["library_ref"]
    identity = load_identity(store, library, request["identity_revision"])
    ontology = OntologyRepository(store).routing_bundle(library, request["ontology_alignment_ref"])
    refs = set(request["statement_refs"])
    affected_statements = sorted(refs | set(request.get("withdrawn_statement_refs", ())))
    with store.transaction(readonly=True) as (q, _):
        state = head(q, library)
        base_view = request["base_view_revision"]
        require(state["active_view_revision"] == base_view, "VIEW_BASE_STALE")
        adopted = manifest(q, library, base_view) if base_view else None
        history = confirmed_history(q, library, base_view)
        previous_sources = defaultdict(dict)
        annotations = None
        if adopted and request["trigger"]["kind"] == "SOURCE_CHANGED":
            prior = read_routing_base(q, library, history, adopted, [], affected_statements)
            annotations = restore_statement_annotations(prior, refs)
            for support in prior["supports"]:
                source = support["rust_source"]
                previous_sources[support.get("statement_ref")][source["source_version_id"]] = source
        statements = routing_statements(identity, annotations)
        for statement, sources in previous_sources.items():
            if statement in statements:
                statements[statement]["previous_sources"] = sources
        groups = group_keys_for(request, ontology, statements)
        base = read_routing_base(q, library, history, adopted, groups, affected_statements)
    return prepare_routing(request, ontology, statements, base, engine)


def _lexical(kind, key, row):
    if kind == "NODE":
        text = "\n".join([row["label"], *row.get("aliases", [])])
    elif kind == "SOURCE":
        text = row.get("text") or row.get("preview") or ""
    else:
        content = row["content"]
        text = " ".join(str(value) for value in [row["label"], row.get("subject_label") or content["subject_ref"],
                                                 content["value"], *row.get("raw_properties", [])])
    return dict(object_ref=key, text=text)


def _deltas(old, new):
    changed = defaultdict(dict)
    for kind, key in sorted(old.keys() | new.keys()):
        if old.get((kind, key)) != new.get((kind, key)):
            changed[kind][key] = new.get((kind, key))
    return dict(changed)


def _entities(identity, snapshot):
    result = {}
    for occurrence_ref, binding in identity["bindings"].items():
        key = binding["entity_ref"]
        occurrence = identity["occurrences"][occurrence_ref]
        row = result.setdefault(key, dict(id=key, label=binding.get("label") or occurrence["name_raw"],
                                          aliases=set(), type_refs=set(), pending=False, attributes=[]))
        row["aliases"].add(occurrence["name_raw"])
        row["aliases"].update(alias["name_raw"] for alias in occurrence.get("alias_observations", []))
    binding_defs = {row["binding_ref"]: row.get("definition_ref") for row in snapshot["bindings"]}
    for assignment in snapshot["assignments"]:
        entity = identity["bindings"].get(assignment.get("target_occurrence_ref"))
        definition = binding_defs[assignment["binding_ref"]]
        if entity and definition:
            result[entity["entity_ref"]]["type_refs"].add(definition)
    return {key: dict(row, aliases=sorted(row["aliases"] - {row["label"]}), type_refs=sorted(row["type_refs"]))
            for key, row in result.items()}


def _put_source(rows, source):
    key = source.get("source_ref") or source_ref(source)
    location = {field: source[field] for field in ("doc_ref", "revision", "chunk_ref", "unit_ref", "task_ref")
                if field in source}
    item = dict(source, source_ref=key, location=location)
    stored = rows.get(("SOURCE", key))
    if stored:
        require(stored.get("text") == item.get("text"), "SOURCE_BYTES_CHANGED", 422)
    else:
        rows["SOURCE", key] = item
    return key


def _apply_fact_projection(rows, bundle):
    rust = bundle["rust"]
    versions, _ = fold_plan(rust["input"]["prepare"]["base"], rust["output"]["plan"])
    affected = set(bundle["affected_group_keys"])
    for (kind, key), current in list(rows.items()):
        if kind in {"FACT", "EDGE", "REVIEW"} and (
            current.get("group_key") in affected or affected.intersection(current.get("impact", {}).get("group_keys", []))
        ):
            rows.pop((kind, key))
    review_refs = defaultdict(list)
    for review in bundle["reviews"]:
        sources = [_put_source(rows, item["location"]) for side in review["sides"] for item in side["evidence"]]
        rows["REVIEW", review["review_ref"]] = dict(review, target_kind=review["review_kind"],
                                                    source_refs=sorted(set(sources)))
        for side in review["sides"]:
            review_refs[side["fact_ref"]].append(review["review_ref"])
    for key, version in versions.items():
        content = version["content"]
        meta = bundle["assertions"][key]
        current_supports = bundle["supports"][key]
        sources = sorted({_put_source(rows, item["source"]) for item in current_supports})
        statements = sorted({item["statement_ref"] for item in current_supports if item.get("statement_ref")})
        fact = dict(fact_ref=key, fact_version_ref=version["fact_version_id"], source_refs=sources,
                    statement_refs=statements, definition_ref=meta["definition_ref"], label=meta["property"],
                    content=content, world_time=version["valid_time"], asserted_world_time=version["asserted_valid_time"],
                    world_time_raw=version["asserted_valid_time"], group_key=version["state_group"]["key"],
                    state=meta["state"], review_refs=sorted(review_refs[key]),
                    subject_label=meta.get("subject_label"), raw_properties=sorted({
                        (rows.get(("STATEMENT", statement), {}).get("candidate") or {}).get("relation_phrase") or ""
                        for statement in statements}),
                    modality=content["modality"], negated=content["negated"])
        rows["FACT", key] = fact
        value = content["value"]
        if value.get("kind") == "ENTITY":
            rows["EDGE", key] = dict(id=key, source=content["subject_ref"], target=value["entity_ref"],
                                     **{field: fact[field] for field in (
                                         "fact_ref","fact_version_ref","definition_ref","label","group_key","state",
                                         "review_refs","modality","negated")})


def prepare_publication(store, bundle, *, run_ref=None, resolved_review=None, upstream_gaps=(),
                        identity_snapshot=None, ontology_plan=None, identity_change=None):
    verify(bundle)
    request = bundle["request"]
    library, base = request["library_ref"], request["base_view_revision"]
    identity = identity_snapshot or load_identity(store, library, request["identity_revision"])
    ontology = OntologyRepository(store)
    if ontology_plan is not None:
        alignment = ontology_plan["result"]
        definitions = ontology_plan["snapshot"]
    else:
        alignment = ontology.read(library, request["ontology_alignment_ref"])
        definitions = ontology.snapshot(library, request["ontology_alignment_ref"])
    require(alignment["identity_revision"] == identity["identity_revision"] == request["identity_revision"]
            and alignment["target_ontology_revision"] == request["ontology_alignment_ref"],
            "ONTOLOGY_IDENTITY_MISMATCH", 422)
    with store.transaction(readonly=True) as (q, _):
        adopted = manifest(q, library, base) if base else None
        previous = projection(q, library, base, GRAPH_KINDS)
        index_before = projection(q, library, base, INDEX_KINDS)
        history = confirmed_history(q, library, base)
        feedback = review_rows(q, library, base)
        from ontoweave_identity.compound_decisions import identity_review_projection, overlay_review_projection
        if identity_change is None:
            identity_reviews = identity_review_projection(q, library, identity["identity_revision"])
        else:
            identity_reviews = overlay_review_projection(q, library, identity_change)
    if adopted:
        require(alignment["base_view_revision"] == base or
                adopted["ontology_revision"] == request["ontology_alignment_ref"], "ONTOLOGY_BASE_MISMATCH", 422)
    next_graph = {**previous, **feedback}
    source_changed = request["trigger"]["kind"] == "SOURCE_CHANGED"
    if source_changed:
        withdrawn = set(request["withdrawn_statement_refs"])
        for statement in withdrawn:
            next_graph.pop(("STATEMENT", statement), None)
            next_graph.pop(("EDGE", statement), None)
    for key, row in feedback.items():
        if row.get("target_kind") == "ONTOLOGY" and row.get("review_status") == "OPEN":
            # The old comparison basis is still available in its parent view.
            next_graph.pop(key, None)
    for (kind, key), row in previous.items():
        if kind in {"NODE", "DEFINITION"} or (kind == "REVIEW" and row.get("target_kind") == "IDENTITY"
                                              and row.get("review_status") == "OPEN"):
            next_graph.pop((kind, key))
    next_graph.update({("REVIEW", key):row for key,row in identity_reviews.items()})
    next_graph.update({("NODE", key): row for key, row in _entities(identity, definitions).items()})
    binding_lists = defaultdict(list)
    for row in definitions["bindings"]:
        if row.get("definition_ref"):
            binding_lists[row["definition_ref"]].append(row)
    for row in definitions["definitions"]:
        key = row["definition_ref"]
        next_graph["DEFINITION", key] = dict(row, bindings=binding_lists[key],
                                            source_refs=sorted({item["source_ref"] for item in row.get("supports", [])}))
    for occurrence in identity["occurrences"].values():
        for source in occurrence["source_refs"]:
            _put_source(next_graph, source)
    for statement_ref, statement in identity["statements"].items():
        for source in statement["source_refs"]:
            _put_source(next_graph, source)
    for result in bundle["result"]["statement_results"]:
        key = result["statement_ref"]
        statement = identity["statements"].get(key)
        require(statement, "STATEMENT_NOT_IN_IDENTITY_REVISION", 422, statement_ref=key)
        sources = [_put_source(next_graph, source) for source in statement["source_refs"]]
        row = {**statement, **{k:v for k,v in result.items() if k != "warnings"}, "source_refs":sources}
        next_graph["STATEMENT", key] = row
        next_graph.pop(("EDGE", key), None)
        if result["routing_result"] == "OPEN_UNINTERPRETED":
            candidate = statement["candidate"]
            endpoints = {endpoint["role"]: identity["bindings"][endpoint["occurrence_ref"]]["entity_ref"]
                         for endpoint in statement["endpoints"]}
            label = candidate.get("relation_phrase") or candidate.get("predicate")
            if endpoints.get("SUBJECT") and endpoints.get("OBJECT") and label:
                next_graph["EDGE", key] = dict(id=key, source=endpoints["SUBJECT"], target=endpoints["OBJECT"],
                                             label=label, state="OPEN_UNINTERPRETED", statement_ref=key,
                                             source_refs=sources)
    _apply_fact_projection(next_graph, bundle)
    if source_changed:
        active_sources = {source_ref(source) for row in identity["occurrences"].values() for source in row["source_refs"]}
        active_sources.update(source_ref(source) for row in identity["statements"].values() for source in row["source_refs"])
        active_sources.update(source for (kind, _), row in next_graph.items() if kind == "FACT"
                              for source in row["source_refs"])
        bound_definitions = {row.get("definition_ref") for row in definitions["bindings"]}
        bound_definitions.update(row["definition_ref"] for (kind, _), row in next_graph.items() if kind == "FACT")
        for (kind, key), row in list(next_graph.items()):
            if kind == "SOURCE" and key not in active_sources:
                next_graph.pop((kind, key))
            elif kind == "REVIEW" and (not set(row.get("source_refs", [])) <= active_sources or
                                       any(("NODE", entity) not in next_graph for entity in row.get("entity_refs", []))):
                next_graph.pop((kind, key))
            elif kind == "DEFINITION" and key not in bound_definitions:
                next_graph.pop((kind, key))
    if resolved_review:
        key = resolved_review["review_ref"]
        if resolved_review.get("target_kind") in {"IDENTITY","ONTOLOGY"} or ("REVIEW", key) not in next_graph:
            fields = {k:v for k,v in resolved_review.items()
                      if k not in {"view_revision","base_view_revision","decision","decision_receipt","read_only"}}
            next_graph["REVIEW", key] = dict(fields, review_status="DECIDED", available_actions=[])
    for (kind, _), review in next_graph.items():
        if kind == "REVIEW" and review.get("target_kind") == "IDENTITY" and review.get("review_status") == "OPEN":
            for key in review["entity_refs"]:
                if ("NODE", key) in next_graph:
                    next_graph["NODE", key]["pending"] = True
    counts = Counter()
    for (kind, key), row in list(next_graph.items()):
        if kind == "NODE":
            counts.update(row["type_refs"])
        if kind == "FACT":
            counts[row["definition_ref"]] += 1
            value = row["content"]["value"]
            node = ("NODE", row["content"]["subject_ref"])
            if value.get("kind") != "ENTITY" and node in next_graph:
                next_graph[node]["attributes"].append(dict(fact_ref=key, definition_ref=row["definition_ref"],
                                                          label=row["label"], value=value, state=row["state"],
                                                          negated=row["negated"], modality=row["modality"]))
    for (kind, key), row in list(next_graph.items()):
        if kind == "NODE":
            row["attributes"].sort(key=lambda item: item["fact_ref"])
        elif kind == "DEFINITION":
            row["instance_count"] = counts[key]
    kinds = {"NODE":"ENTITY_NAME", "FACT":"FACT_LEXICAL", "SOURCE":"SOURCE_LEXICAL"}
    index = {(kinds[kind], key): _lexical(kind,key,row) for (kind,key),row in next_graph.items() if kind in kinds}
    _validate_graph(next_graph)
    _validate_index(index, next_graph)
    delta, index_delta = _deltas(previous, next_graph), _deltas(index_before, index)
    redirects = {}
    if adopted and adopted["identity_revision"] != request["identity_revision"]:
        old_identity = load_identity(store, library, adopted["identity_revision"])
        candidates = defaultdict(set)
        for key, previous_binding in old_identity["bindings"].items():
            after = identity["bindings"].get(key)
            if after:
                candidates[previous_binding["entity_ref"]].add(after["entity_ref"])
        for old, targets in sorted(candidates.items()):
            if len(targets) == 1 and ("NODE", old) not in next_graph:
                redirects[old] = next(iter(targets))
    redirects = [dict(**{"from":old, "to":target}) for old,target in redirects.items()]
    result_gaps = [*upstream_gaps, *alignment.get("gaps", []), *bundle["result"]["gaps"]]
    if adopted and request["trigger"]["kind"] == "HUMAN_DECISION":
        result_gaps = [*adopted["gaps"], *bundle["result"]["gaps"]]
    gaps = {digest(item): item for item in result_gaps}
    status = bundle["result"]["execution_status"]
    if gaps and status == "COMPLETED":
        status = "PARTIAL"
    args = dict(contract="ontoweave-publication-input/1", library_ref=library,
                request_ref=request["operation_ref"], trigger=request["trigger"], base_view_revision=base,
                run_ref=run_ref, source_manifest_ref=request["source_manifest_ref"],
                fact_bundle_ref=bundle["bundle_ref"], fact_bundle_sha=bundle["body_sha"],
                target_revisions=dict(identity_revision=request["identity_revision"],
                                      ontology_revision=request["ontology_alignment_ref"],
                                      time_revision=request["time_revision"],
                                      fact_revision=ref("fact_revision", library, bundle["bundle_ref"])),
                scope={"statement_refs":request["statement_refs"],"compare_group_refs":bundle["affected_group_keys"]},
                base_fact_revisions=[item["fact_revision"] for item in history], execution_status=status,
                coverage="PARTIAL" if gaps else "FULL", gaps=list(gaps.values()))
    from ontoweave_index.publication import PublicationIndex

    index_service = getattr(store, "retrieval_preparer", None) or PublicationIndex(store)
    if index_service.enabled(adopted):
        args["retrieval_index_required"] = True
        if request["trigger"]["kind"] != "HUMAN_DECISION":
            args["prepared_index"] = index_service.prepare(args, next_graph)
    diff = _diff(previous, next_graph, redirects)
    return dict(publication=args, bundle=bundle, graph_delta=delta, index_delta=index_delta, redirects=redirects,
                diff=diff)


class FactDecisionPlanner:
    def __init__(self, store, engine):
        self.store, self.engine = store, engine

    def __call__(self, library, adopted, review, request, *, actor, revert):
        if revert:
            return self._undo_review(library, adopted, review, request)
        require(review["target_kind"] == "FACT", "DECISION_DOMAIN_UNAVAILABLE", 422)
        view = adopted["view_revision"]
        intent = request["intent"]
        with self.store.transaction(readonly=True) as (q, _):
            history = confirmed_history(q, library, view)
            base = read_routing_base(q, library, history, adopted, review["impact"]["group_keys"])
            if review.get("proactive_fact_ref"):
                base["review_overrides"] = {review["review_ref"]: review}
            groups = intent_group_keys(dict(review,review_status="OPEN"), intent, base, library)
            if set(groups) != set(review["impact"]["group_keys"]):
                base = read_routing_base(q, library, history, adopted, groups)
                if review.get("proactive_fact_ref"):
                    base["review_overrides"] = {review["review_ref"]: review}
        operation = request["client_operation_ref"]
        routing = routing_request(library, ref("fact_decision_plan", library, operation, view), adopted,
                                  adopted["identity_revision"], adopted["ontology_revision"], adopted["time_revision"],
                                  adopted["source_manifest_ref"], [], {"kind":"HUMAN_DECISION","refs":[review["review_ref"]]})
        decision = ref("decision", library, operation)
        draft = preview_fact_intent(dict(review,review_status="OPEN"), intent, base, routing, self.engine,
                                    decision_ref=decision, actor_ref=actor)
        plan = prepare_publication(self.store, draft["bundle"], resolved_review=dict(review,decision_ref=decision))
        graph_changes = plan.pop("diff")
        plan.update(before={"facts":draft["before"]}, after={"facts":draft["after"]},
                    impact=dict(draft["impact"], graph=graph_changes,
                                index={key:len(rows) for key, rows in plan["index_delta"].items()}, unknown=[]))
        return plan

    def _undo_review(self, library, adopted, decision, request):
        original = decision["request"]["intent"]
        require(original["kind"] == "KEEP_BOTH", "FACT_REVERT_REQUIRES_EXPLICIT_CORRECTION", 422)
        groups = decision["plan"]["bundle"]["affected_group_keys"]
        view = adopted["view_revision"]
        review_ref = decision["review_ref"]
        with self.store.transaction(readonly=True) as (q, _):
            job = q("""SELECT target_view_revision FROM publication_v1.jobs
                       WHERE library_ref=%s AND job_ref=%s AND status='SUCCEEDED'""",
                    [library,decision["job_ref"]]).fetchone()
            require(job, "DECISION_REVERT_NOT_APPLICABLE", 422)
            applied = manifest(q, library, job["target_view_revision"])
            require(all(applied[key] == adopted[key] for key in ("identity_revision","ontology_revision","time_revision")),
                    "DECISION_REVERT_DEPENDENCIES_CHANGED")
            current = read_routing_base(q, library, confirmed_history(q, library, view), adopted, groups)
            prior = read_routing_base(q, library, confirmed_history(q, library, applied["view_revision"]), applied, groups)
            require(current["group_digests"] == prior["group_digests"], "DECISION_REVERT_DEPENDENCIES_CHANGED")
            basis = projection(q, library, decision["basis_view_revision"], ("REVIEW",)).get(("REVIEW",review_ref))
            require(basis and basis["review_status"] == "OPEN", "DECISION_REVERT_BASIS_UNAVAILABLE")
        operation = ref("fact_review_reopen", library, view, request["client_operation_ref"])
        routing = routing_request(library, operation, adopted, adopted["identity_revision"],
                                  adopted["ontology_revision"], adopted["time_revision"], adopted["source_manifest_ref"],
                                  [], {"kind":"HUMAN_DECISION","refs":[review_ref]})
        rust = dict(prepare=dict(request_id=operation, library_id=library,
                                 base={key:current[key] for key in EMPTY_BASE}, updates=[]),
                    groups=current["policies"], base_time_alternatives=base_time_alternatives(current))
        result = self.engine("prepare_fact_routing", rust)
        require(result["rule_version"] == RULE_VERSION, "FACT_RUST_RULE_VERSION_MISMATCH", 503)
        source_rows = {row["rust_source"]["source_version_id"]:row for row in current["supports"]}
        metadata = {key:dict(value) for key,value in current["assertions"].items()}
        bundle = assemble_bundle(routing, current, result, rust, metadata, source_rows, {}, {}, [], {review_ref:basis})
        require(any(item["review_ref"] == review_ref and item["review_status"] == "OPEN" for item in bundle["reviews"]),
                "DECISION_REVERT_BASIS_UNAVAILABLE")
        plan = prepare_publication(self.store, bundle)
        plan.update(before={"review_status":"DECIDED"}, after={"review_status":"OPEN"},
                    impact=dict(affected_fact_refs=list(current["assertions"]), graph=plan.pop("diff"),
                                index={key:len(rows) for key,rows in plan["index_delta"].items()}, unknown=[]))
        return plan


class WorldTimeFilter:
    def __init__(self, store, engine):
        self.store, self.engine = store, engine

    def __call__(self, library, adopted, rows, at):
        with self.store.transaction(readonly=True) as (q, _):
            history = confirmed_history(q, library, adopted["view_revision"])
            snapshot = read_routing_base(q, library, history, adopted, None)
        selected = self.engine("select_routed_fact_versions", dict(selected_seq=adopted["activation_seq"],
                               at=dict(value=at, precision="EXACT", raw=at, basis="request"),
                               versions=snapshot["versions"], support_links=snapshot["support_links"]))
        matches = {entry["fact"]["fact_id"]: dict(status=kind.upper(), reasons=entry["reasons"])
                   for kind, entries in selected.items() for entry in entries}
        result = {}
        for (kind, key), row in rows.items():
            if kind == "NODE":
                attrs = [dict(attr, world_match=matches[attr["fact_ref"]]) for attr in row["attributes"]
                         if matches[attr["fact_ref"]]["status"] != "EXCLUDED"]
                result[kind,key] = dict(row, attributes=attrs)
            elif kind in {"EDGE", "FACT"}:
                match = matches.get(row.get("fact_ref"), dict(status="POSSIBLE", reasons=["OPEN_WORLD_TIME_UNKNOWN"]))
                if match["status"] != "EXCLUDED":
                    result[kind,key] = dict(row, world_match=match)
            else:
                result[kind,key] = row
        return result
