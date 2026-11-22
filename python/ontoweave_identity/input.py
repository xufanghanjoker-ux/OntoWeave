"""Recover source-local identities from independently authenticated reception items."""

from collections import Counter, defaultdict
import re
import unicodedata

from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest


def ref(kind, value):
    return kind + "_" + digest(value)


def name_key(value, casefold=True):
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    return normalized.casefold() if casefold else normalized


def source_key(source):
    return tuple(source.get(k) for k in ("doc_ref", "revision", "chunk_ref", "unit_ref"))


def _source_rows(task, record):
    sources = []
    for label in record["sources"]:
        unit = task["sources"].get(label)
        if unit:
            sources.append(dict(**unit, precision="UNIT", extraction_label=label))
    return sources or [dict(precision="TASK_ONLY", task_ref=task["task_ref"])]


def _occurrence(origin, role, position, name, sources, statement, old_ref, record):
    producer = origin.get("producer") or {}
    scope = [list(source_key(s)) if s["precision"] == "UNIT" else [producer.get("task_ref", s["task_ref"])]
             for s in sources]
    key = ["ontoweave-occurrence/1", origin["raw_sha256"], origin["byte_start"],
           origin["byte_end"], role, position, scope]
    is_declaration = role == "DECLARATION"
    raw_type = record.get("type") if is_declaration else None
    aliases = (record.get("aliases") or []) if is_declaration else []
    observations = [
        dict(name_raw=alias, name_key=name_key(alias), evidence_level="MODEL_DECLARATION")
        for alias in aliases if isinstance(alias, str) and name_key(alias)
    ]
    # The current extraction contract does not declare reliable unique identifiers.
    return dict(
        occurrence_ref=ref("occ", key), origin={**origin, "role_position": position},
        role=role, name_raw=name, name_key=name_key(name), mention_ref=old_ref,
        type_observations=[dict(type_raw=raw_type, evidence_level="MODEL_DECLARATION")] if raw_type else [],
        alias_observations=observations, category_raw=record.get("category_raw") if is_declaration else None,
        identity_claims=[], source_refs=sources, statement_refs=[statement] if statement else [],
        warnings=[],
    )


def recover(run, producer_origins=None):
    """Recover occurrences and statements while preserving the originating candidate."""
    producer_origins = producer_origins or {}
    tasks = {t["task_ref"]: t for t in run["tasks"]}
    candidates = {c["candidate_ref"]: c for c in run["candidates"]}
    responses = {r["response_ref"]: r for r in run["responses"]}
    occurrences, statements, gaps, received = {}, {}, [], set()
    for receipt in run["receipts"]:
        task = tasks[receipt["task_ref"]]
        response = responses[receipt["response_ref"]]
        if (receipt["policy"] != run["reception_policy"] or receipt["late"] or response["late"]
                or not task["frozen"] or receipt.get("execution_status", receipt["reception_status"]) not in ("COMPLETED", "PARTIAL", "SAVED")):
            gaps.append(dict(code="RECEPTION_NOT_ELIGIBLE", receipt_ref=receipt["receipt_ref"],
                             status=receipt.get("execution_status", receipt["reception_status"])))
            continue
        delivery = response["delivery"]
        native = delivery.get("native_completion") or {}
        identity = response["identity"]
        returned = (delivery["outcome"] == "RETURNED" and delivery.get("transport_complete")
                    and delivery.get("identity_verified") and native
                    and all(native.get(k) == identity.get(k) for k in ("thread_id", "turn_id")))
        certified_prefix = (delivery["outcome"] == "KNOWN_INCOMPLETE"
                            and all(delivery.get(k) for k in ("explicit_terminal", "identity_verified",
                                                             "raw_authenticated", "certified_complete_message")))
        if not (returned or certified_prefix):
            require(not receipt["items"], "UNAUDITED_RECEIPT_HAS_ITEMS")
            gaps.append(dict(code="RESPONSE_NOT_ADOPTED", response_ref=response["response_ref"]))
            continue
        raw = bytes.fromhex(response["raw_hex"])
        require(response["task_ref"] == task["task_ref"] and sha(raw) == response["sha256"]
                == receipt["raw_sha256"], "SOURCE_RESPONSE_AUTHENTICATION_FAILED")
        receipt_candidates = set()
        for item in receipt["items"]:
            record = item["record"]
            start, end = record["start"], record["end"]
            item_ref = ref("item", [task["task_ref"], response["response_ref"], receipt["policy"], start, end])
            require(0 <= start < end <= len(raw) and raw[start:end] == record["raw_utf8"].encode("utf-8")
                    and item_ref == item["item_ref"], "SOURCE_ITEM_AUTHENTICATION_FAILED")
            candidate_ref = item.get("candidate_ref")
            origin = dict(run_id=task["run_id"], requested_run_id=run["run_id"],
                          namespace=run["namespace"], task_ref=task["task_ref"],
                          response_ref=response["response_ref"], response_identity=identity,
                          raw_sha256=response["sha256"], receipt_ref=receipt["receipt_ref"],
                          item_ref=item_ref, candidate_ref=candidate_ref, byte_start=start, byte_end=end,
                          coordinate_system="MODEL_RESPONSE_UTF8_BYTES")
            producer = producer_origins.get(response["response_ref"])
            if producer:
                original = producer["response"]
                original_item = producer["items"].get((start, end)) or {}
                origin["producer"] = dict(namespace=producer["namespace"], run_id=producer["run_id"],
                                          task_ref=original["task_ref"], response_ref=original["response_ref"],
                                          receipt_ref=(producer["receipt"] or {}).get("receipt_ref"),
                                          item_ref=original_item.get("item_ref"),
                                          candidate_ref=original_item.get("candidate_ref"),
                                          item_alignment="EXACT_RANGE" if original_item else "RAW_RANGE_ONLY")
            sources = _source_rows(task["manifest"], record)
            statement_ref = None
            endpoints = []
            if candidate_ref:
                candidate = candidates[candidate_ref]
                payload = candidate["payload"]
                require(candidate["task_ref"] == task["task_ref"]
                        and candidate["disposition"] == item["disposition"]
                        and candidate_ref == ref("candidate", [task["task_ref"], payload]),
                        "SOURCE_CANDIDATE_AUTHENTICATION_FAILED")
                receipt_candidates.add(candidate_ref)
                received.add(candidate_ref)
                statement_ref = ref("statement", [response["response_ref"], item_ref])
                endpoints = [
                    ("SUBJECT", 0, record.get("subject"), payload.get("subject_mention_ref")),
                    ("OBJECT", 0, record.get("value_raw") if payload["value_kind"] == "客体" else None,
                     payload.get("object_mention_ref")),
                ]
                endpoints.extend(("QUALIFIER_ENTITY", i, qualifier["value"], qualifier.get("mention_ref"))
                                 for i, qualifier in enumerate(payload["qualifiers"])
                                 if qualifier.get("value_kind") == "限定实体")
                statements[statement_ref] = dict(
                    statement_ref=statement_ref, candidate_ref=candidate_ref, disposition=item["disposition"],
                    origin=origin, candidate=payload, record=record, source_refs=sources,
                    endpoints=[], warnings=item["warnings"],
                )
            elif item["disposition"] == "ENTITY" and item.get("mention_ref"):
                endpoints = [("DECLARATION", 0, record["name"], item["mention_ref"])]
            elif item["disposition"] == "SKIPPED":
                gaps.append(dict(code="SOURCE_ITEM_SKIPPED", origin=origin, diagnostics=record["diagnostics"]))
            for role, position, name, old_ref in endpoints:
                if not name or not name_key(name):
                    continue
                occurrence = _occurrence(origin, role, position, name, sources, statement_ref, old_ref, record)
                key = occurrence["occurrence_ref"]
                require(key not in occurrences or occurrences[key] == occurrence, "OCCURRENCE_ORIGIN_CONFLICT")
                occurrences[key] = occurrence
                if statement_ref:
                    statements[statement_ref]["endpoints"].append(
                        dict(occurrence_ref=key, role=role, position=position))
        require(receipt_candidates == set(receipt["candidate_refs"]), "SOURCE_RECEIPT_CANDIDATE_COVERAGE")
        gaps.extend(dict(code="SOURCE_RECEPTION_GAP", receipt_ref=receipt["receipt_ref"], detail=g)
                    for g in receipt["gaps"])
    gaps.extend(dict(code="CANDIDATE_WITHOUT_ELIGIBLE_RECEIPT", candidate_ref=c)
                for c in sorted(candidates.keys() - received))
    return occurrences, statements, gaps


def _documents(occurrence):
    return {(s["doc_ref"], s["revision"]) for s in occurrence["source_refs"] if s["precision"] == "UNIT"}


def _units(occurrence):
    return {source_key(s) for s in occurrence["source_refs"] if s["precision"] == "UNIT"}


def _sequence(value):
    return tuple(re.findall(r"[a-z0-9]+|[\u3400-\u9fff]", name_key(value)))


def _source_label_anchor(source, label, pattern):
    matches = list(re.finditer(pattern, source["text"], re.IGNORECASE))
    if len(matches) != 1:
        return None
    match = matches[0]
    return [list(source_key(source)), label, match.start(), match.end()]


def _qualified_work_anchor(name, source):
    work = re.fullmatch(r'新版\s*["“「]?([^"”」]+?)["”」]?\s*电影', name)
    if not work:
        return None
    label = work[1].strip()
    pattern = (r"\b(?:remake|latest (?:film|movie)|new (?:film|movie))\b[^.!?]{0,55}"
               r'\b(?:[0-9]+(?:st|nd|rd|th)\s+)["“]' + re.escape(label) + r'["”]\s+(?:film|movie)\b')
    return _source_label_anchor(source, name_key("新版" + label + "电影"), pattern)


def _qualified_role_anchor(name, source):
    role = re.fullmatch(r"(新版|初版|原版|原著)\s*(.+?)\s*[（(](?:角色|主角)[）)]", name)
    if not role:
        return None
    version, label = role.groups()
    version_pattern, medium = {
        "新版": (r"(?:latest|new(?:est)?)", r"(?:film|movie|series|play)"),
        "初版": (r"(?:first|original)", r"(?:film|movie|series|play)"),
        "原版": (r"original", r"(?:film|movie|series|play)"),
        "原著": (r"original", r"(?:novel|book|story|play)"),
    }[version]
    pattern = (r"(?<!\w)" + re.escape(label) + r"\s+(?:in|from)\s+(?:the\s+)?"
               + version_pattern + r"\s+" + medium + r"(?!\w)")
    return _source_label_anchor(source, name_key(name), pattern)


def _unique_literal_anchor(occurrence):
    """One distinctive literal name in one authenticated unit is a local anchor."""
    sources = [s for s in occurrence["source_refs"] if s["precision"] == "UNIT"]
    name = occurrence["name_raw"].strip()
    if len(sources) != 1 or not name or len(_sequence(name)) < 2:
        return None
    if occurrence.get("mention_ref"):
        scoped = _qualified_role_anchor(name, sources[0]) or _qualified_work_anchor(name, sources[0])
        if scoped:
            return scoped
    if occurrence["role"] != "SUBJECT":
        return None
    # A single generic surface phrase is insufficient. Require a proper name
    # signalled by source spelling, or a quoted explicit label.
    quoted = r'["“「]' + re.escape(name) + r'["”」]'
    proper = name[:1].isupper() and any(word[:1].isupper() for word in name.split()[1:])
    expression = r"(?<!\w)" + re.escape(name) + r"(?!\w)"
    text = sources[0]["text"]
    matches = list(re.finditer(expression, text, re.IGNORECASE))
    name_pattern = re.escape(name)
    unique = list(re.finditer(
        r"(?<!\w)(?:there (?:is|was) (?:only|exactly|just) one|the (?:only|sole))\s+"
        + name_pattern + r"(?!\w)|(?:唯一(?:的)?|仅有一(?:个|台|座|名))\s*" + name_pattern,
        text, re.IGNORECASE,
    ))
    if len(unique) == 1:
        anchor = unique[0]
    elif len(matches) == 1 and (proper or re.search(quoted, text, re.IGNORECASE)):
        anchor = matches[0]
    else:
        return None
    return [list(source_key(sources[0])), name_key(name), anchor.start(), anchor.end()]


SCORELINE_REPORT = re.compile(
    r"(?<!\d)\d+[-–]\d+\s+(?:win|victory|draw|loss|defeat)\b[^.!?]{0,60}"
    r"\b(?:over|against|with|to)\s+[^.!?]{2,100}", re.IGNORECASE,
)
MATCH_SHIFT = re.compile(r"\b(?:another|other|next)\b[^.!?]{0,25}\b(?:match|game)\b", re.IGNORECASE)


def _match_context_anchor(occurrence, statements):
    if (occurrence["role"] != "OBJECT" or not occurrence.get("mention_ref")
            or not re.fullmatch(r".+?\s*(?:vs\.?|对阵)\s*.+", occurrence["name_raw"], re.IGNORECASE)):
        return None
    units = [s for s in occurrence["source_refs"] if s["precision"] == "UNIT"]
    if len(units) != 1 or len(occurrence["statement_refs"]) != 1:
        return None
    source, = units
    statement = statements.get(occurrence["statement_refs"][0])
    if not statement or source_key(source) not in {source_key(s) for s in statement["source_refs"]}:
        return None
    candidate = statement["candidate"]
    actor = candidate.get("subject") or ""
    if len(_sequence(actor)) < 2 or candidate.get("value_raw") != occurrence["name_raw"]:
        return None
    text = source["text"]
    actors = list(re.finditer(r"(?<!\w)" + re.escape(actor) + r"(?!\w)", text, re.IGNORECASE))
    if not actors:
        return None
    reports = list(SCORELINE_REPORT.finditer(text))
    boundaries = [*reports, *MATCH_SHIFT.finditer(text)]
    scopes = [(report, min((b.start() for b in boundaries if b.start() > report.end()), default=len(text)))
              for report in reports]
    # Each named participant must be traceable to one uninterrupted result context.
    # An explicit time, when it appears in the source, must occur in that same context.
    for report, end in scopes:
        start = report.end()
        if not all(start <= hit.start() < end for hit in actors):
            continue
        times = [t["value"].strip() for t in candidate.get("times", []) if t.get("value")]
        positions = [m.start() for time in times if len(time) >= 5
                     for m in re.finditer(re.escape(time), text, re.IGNORECASE)]
        if all(start <= position < end for position in positions):
            return [list(source_key(source)), name_key(occurrence["name_raw"]), report.start(), report.end()]
    return None


def build_profiles(library, occurrences, known=None, *, statements=None):
    """Retain an anchor only when the declaration or explicit source label is unique."""
    known = known or {}
    registry = {**known, **occurrences}
    declarations = defaultdict(list)
    names_per_unit = defaultdict(set)
    unbound_names = Counter()
    for key, occurrence in registry.items():
        name = occurrence["name_raw"]
        response = occurrence["origin"]["response_ref"]
        if occurrence["role"] == "DECLARATION":
            declarations[response, name].append(key)
            for unit in _units(occurrence):
                names_per_unit[unit, name].add(key)
        else:
            unbound_names[response, name] += 1
    homes, profiles = {}, defaultdict(list)
    for key, occurrence in sorted(occurrences.items()):
        if key in known:
            home = known[key]["home_entity_ref"]
            occurrences[key] = known[key]
        else:
            docs, units = _documents(occurrence), _units(occurrence)
            slot = (occurrence["origin"]["response_ref"], occurrence["name_raw"])
            local = {d for d in declarations[slot] if len(docs) == 1 and _documents(registry[d]) == docs}
            unit_declarations = {d for unit in units for d in names_per_unit[unit, occurrence["name_raw"]]}
            alternatives = local | unit_declarations
            home = ref("entity", [library, key])
            if occurrence["role"] != "DECLARATION":
                if len(alternatives) == 1:
                    declaration = next(iter(alternatives))
                    home = known.get(declaration, {}).get("home_entity_ref") or ref("entity", [library, declaration])
                    occurrence["local_binding"] = dict(method="UNIQUE_DECLARATION", occurrence_ref=declaration)
                elif not alternatives and (anchor := _unique_literal_anchor(occurrence)):
                    home = ref("entity", [library, "authorized_source_label", anchor])
                    occurrence["local_binding"] = dict(method="UNIQUE_LITERAL_ANCHOR", source_anchor=anchor)
                elif not alternatives and statements and (anchor := _match_context_anchor(occurrence, statements)):
                    home = ref("entity", [library, "authorized_match_context", anchor])
                    occurrence["local_binding"] = dict(method="ANCHORED_MATCH_CONTEXT", source_anchor=anchor)
                elif len(alternatives) > 1 or unbound_names[slot] > 1:
                    occurrence["warnings"] = [*dict.fromkeys([*occurrence["warnings"], "IDENTITY_CONTEXT_INSUFFICIENT"])]
                    occurrence["competing_declarations"] = sorted(alternatives)
            occurrence["home_entity_ref"] = home
        homes[key] = home
        profiles[home].append(key)
    return homes, dict(profiles)
