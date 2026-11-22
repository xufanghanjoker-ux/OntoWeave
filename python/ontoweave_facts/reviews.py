"""Build stable review identities from qualifying paired evidence."""

from . import RULE_VERSION, digest, ref


REASONS = {
    "TIME_INTERPRETATION_CONFLICT": "材料有两种有依据的时间解释。采用其中一种会使这两条记录处于同一时段，采用另一种则分开。",
    "OPPOSITE_POLARITY": "同一适用范围和时间内，两份材料分别肯定和否定同一命题。",
    "SINGLE_VALUE": "两份材料给出的值不同，且适用范围内已采用同一时段只允许一个值的规则。",
    "INVERSE_UNIQUE": "两份材料指向同一个客体，但已采用的规则要求客体在同一时段只归属一个主体。",
    "MUTUALLY_EXCLUSIVE": "两份材料给出的值在所采用的规则下不能在同一时间和范围内并存。",
}


def _evidence(rows):
    evidence = {}
    for row in rows:
        source = row["source"]
        if source.get("precision") == "HUMAN_REVISION":
            for item in source["evidence"]:
                evidence[digest([source["source_ref"], item["source_ref"]])] = {
                    **item, "human_revision_ref": source["source_ref"],
                }
            continue
        if source.get("precision") not in {"UNIT", "DOCUMENT", "EXACT", "EXACT_RANGE"}:
            continue
        if not (source.get("source_ref") or (source.get("doc_ref") and source.get("revision"))):
            continue
        if source["precision"] in {"UNIT", "EXACT", "EXACT_RANGE"} and not source.get("unit_ref"):
            continue
        source_ref = source.get("source_ref") or ref("fact_source", [
            source.get(key) for key in ("doc_ref", "revision", "chunk_ref", "unit_ref")
        ])
        preview = source.get("text") or source.get("quote")
        evidence[row["rust_source"]["source_version_id"]] = {
            "source_ref": source_ref, "statement_ref": row.get("statement_ref"), "precision": source["precision"],
            "preview": preview, "text": preview, "location": source,
        }
    return [evidence[key] for key in sorted(evidence)]


def review_proposals(conflicts, versions, assertions, supports, request, previous):
    proposals = []
    for pair in conflicts:
        sides = []
        for fact_ref in pair["fact_refs"]:
            version = versions[fact_ref]
            meta = assertions[fact_ref]
            side_supports = supports.get(fact_ref, [])
            evidence = _evidence(side_supports)
            if not evidence:
                break
            sides.append(dict(
                fact_ref=fact_ref, fact_version_ref=version["fact_version_id"],
                subject=meta.get("subject_label") or version["content"]["subject_ref"],
                raw_properties=sorted({row.get("property_raw", "") or "" for row in side_supports}),
                definition_ref=meta["definition_ref"], property=meta["property"],
                value=version["content"]["value"], scope=version["content"]["conditions"]["scope"],
                attribution=version["content"]["conditions"]["attribution"],
                modality=version["content"]["modality"], negated=version["content"]["negated"],
                world_time=version["valid_time"], time_alternatives=meta.get("time_alternatives", []), evidence=evidence,
                source_refs=sorted({row["source_ref"] for row in evidence}),
            ))
        if len(sides) != 2:
            continue
        logical_key = ref("fact_review", [request["library_ref"], pair["group_key"],
                                           pair["fact_refs"], pair["code"]])
        basis = dict(
            fact_version_refs=pair["fact_version_refs"], definition_refs=[s["definition_ref"] for s in sides],
            rule_version=RULE_VERSION, evidence_sha=digest([[s["evidence"], s["time_alternatives"]] for s in sides]),
            constraint_refs=sorted({constraint for fact_ref in pair["fact_refs"]
                                    for constraint in assertions[fact_ref].get("constraint_refs", [])}),
        )
        basis_version = ref("fact_review_basis", [logical_key, basis])
        earlier = previous.get(logical_key, {})
        same_basis = earlier.get("basis_version") == basis_version
        status = earlier.get("review_status", "OPEN") if same_basis else "OPEN"
        label = sides[0]["property"]
        two_states = all(side["world_time"]["kind"] == "STATE" for side in sides)
        timed = any(side["world_time"]["kind"] in {"STATE", "EVENT", "WINDOW"} or side["time_alternatives"] for side in sides)
        actions = [
            {"kind": "CORRECT_FACT", "label": "更正有误记录", "required_fields": ["target_fact_version_ref", "proposed_content", "reason", "evidence_refs"]},
            {"kind": "WITHDRAW_FACT", "label": "撤回其中一条", "required_fields": ["target_fact_version_ref", "reason", "evidence_refs"]},
            {"kind": "REVISE_SCOPE", "label": "修订适用范围", "required_fields": ["target_fact_version_ref", "proposed_scope", "reason", "evidence_refs"]},
            {"kind": "KEEP_BOTH", "label": "保留双方及争议标记", "required_fields": ["reason"]},
            {"kind": "DEFER", "label": "暂缓处理", "required_fields": ["reason"]},
        ]
        if timed:
            actions.insert(0, {"kind": "RETIME_FACT", "label": "修订时间解释", "required_fields": [
                "target_fact_version_ref", "proposed_world_time", "reason", "evidence_refs"]})
        if two_states and all(side["world_time"].get("start") for side in sides):
            actions.insert(0, {"kind": "CLOSE_STATE", "label": "记录旧状态何时结束", "required_fields": [
                "target_fact_version_ref", "proposed_world_time", "reason", "evidence_refs"]})
        proposals.append(dict(
            review_ref=logical_key, logical_review_key=logical_key, review_kind="FACT", target_kind="FACT",
            basis_version=basis_version, review_status=status, sides=sides, conflict_reason=REASONS[pair["code"]],
            evidence=[row for side in sides for row in side["evidence"]],
            source_refs=sorted({source for side in sides for source in side["source_refs"]}),
            comparison_scope=dict(definition_ref=sides[0]["definition_ref"], scope=sides[0]["scope"]),
            title=f"{label}的资料记录有分歧",
            question=f"请根据双方来源判断「{label}」的记录应更正、分开适用范围，还是保留争议。",
            differences={key: [side[key] for side in sides] for key in
                         ("subject", "value", "scope", "world_time", "negated") if sides[0][key] != sides[1][key]},
            available_actions=actions if status == "OPEN" else [],
            impact=dict(affected_fact_refs=pair["fact_refs"], check_status="PENDING_PREVIEW",
                        group_keys=[pair["group_key"]]),
            basis=dict(**basis, view_revision=request.get("base_view_revision")),
            previous_basis_version=earlier.get("basis_version") if earlier and not same_basis else earlier.get("previous_basis_version"),
            previous_decision_ref=earlier.get("decision_ref") or earlier.get("previous_decision_ref"),
            **({"decision_ref": earlier["decision_ref"]} if same_basis and earlier.get("decision_ref") else {}),
        ))
    return proposals
