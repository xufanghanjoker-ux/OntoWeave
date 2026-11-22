"""Package a bounded vocabulary and representative evidence under local labels."""

from itertools import batched

from ontoweave_cq.store import sha
from ontoweave_cq_similarity.core import canonical, digest
from ontoweave_extraction.planner import tokens
from ontoweave_identity.input import ref

from .candidates import recall
from .material_context import MATERIAL_CONTEXT_VERSION, source_context
from .signatures import SIMPLIFIED, representative_cohorts, source_ref

PROMPT = """使用 $ontoweave-ontology-alignment-v1。本批证据仅可通过 ontology_read_material 读取。
收到回执后按 Skill 提交 JSON Lines 业务判断，每行一个短标签记录。"""
DIRECT_PROMPT = """使用 $ontoweave-ontology-alignment-v2。下方是本批固定材料。按 Skill 直接交付 JSON Lines 业务判断。
每个 E 代表其短标签所覆盖的语境。材料足够时无需读取工具。"""
MAX_GROUPS = 12
MAX_MATERIAL_TOKENS = 5000


def materials(groups):
    catalog = dict(signatures={}, definitions={}, sources={}, source_units={}, statements={})
    labels = dict(signatures={}, definitions={})
    definition_labels, unit_labels, source_labels, statement_labels = {}, {}, {}, {}
    index = 0

    def locate(row, candidate):
        key = source_ref(row)
        if key not in unit_labels:
            label = f"L{len(unit_labels) + 1:02d}"
            unit_labels[key] = label
            catalog["source_units"][label] = {k: row[k] for k in
                ("precision", "unit_ref", "task_ref") if k in row}
        unit = unit_labels[key]
        method, ranges = source_context(row, candidate)
        refs = []
        for span in ranges or [None]:
            key = (unit, span if span else method)
            if key not in source_labels:
                label = f"U{len(source_labels) + 1:02d}"
                source_labels[key] = label
                if span:
                    a, b = span
                    catalog["sources"][label] = dict(unit=unit, precision="SOURCE_EXCERPT",
                        location=dict(start=a, end=b, coordinate="UNIT_CODEPOINTS"), text=row["text"][a:b])
                else:
                    catalog["sources"][label] = dict(unit=unit, precision="LOCATION_UNKNOWN", reason=method)
            refs.append(source_labels[key])
        location = dict(method=method, fragments=refs)
        if ranges and "".join("".join(row["text"][a:b].split()) for a, b in ranges) == "".join(row["text"].split()):
            location["extent"] = "COMPLETE_RELATED_UNIT"
        return location

    def example(member):
        statement = member["statement"]
        key = statement["statement_ref"]
        candidate = statement["candidate"]
        if key not in statement_labels:
            label = f"C{len(statement_labels) + 1:02d}"
            statement_labels[key] = label
            locations = [locate(row, candidate) for row in statement["source_refs"]]
            catalog["statements"][label] = dict(
                original=statement["record"]["raw_utf8"], source_locations=locations,
                **{k: candidate[k] for k in ("qualifiers", "times", "extensions") if candidate.get(k)})
        label = statement_labels[key]
        target = member["target"]
        result = dict(component=target["component_role"], surface=member["surface"], statement=label)
        if "type_observation" in target:
            result["observation"] = target["type_observation"]
        if "qualifier_position" in target:
            result["qualifier_position"] = target["qualifier_position"]
        if member["type_evidence"]:
            evidence = {}
            for entry in member["type_evidence"]:
                for source in entry["sources"]:
                    location = locate(source, candidate)
                    evidence[digest([entry["type_raw"], location])] = dict(word=entry["type_raw"], **location)
            result["type_evidence"] = list(evidence.values())
        return result

    for group in groups:
        signature = f"S{len(labels['signatures']) + 1:02d}"
        examples = {}
        evidence = {}
        simplified = group.get("alignment_contract") == SIMPLIFIED
        cohorts = representative_cohorts(group) if simplified else [[m] for m in group["members"]]
        represented = {}
        for cohort in cohorts:
            member = cohort[0]
            index += 1
            key = f"E{index:02d}"
            examples[key] = example(member)
            evidence[key] = member
            represented[key] = cohort
            if simplified and len(cohort) > 1:
                examples[key]["represented_members"] = len(cohort)
        allowed = {}
        for candidate in group["candidates"]:
            definition = candidate["definition"]
            key = definition["definition_ref"]
            if key not in definition_labels:
                label = f"D{len(definition_labels) + 1:02d}"
                definition_labels[key] = label
                labels["definitions"][label] = definition
                catalog["definitions"][label] = {
                    k: definition[k] for k in (
                        "kind", "label", "description", "definition_status", "observed_domains",
                        "observed_ranges", "observed_datatypes", "constraint_refs", "adopted_constraints", "boundary",
                    ) if k in definition
                }
            allowed[definition_labels[key]] = candidate["directions"]
        catalog["signatures"][signature] = dict(kind=group["kind"], shape=group["members"][0]["shape"],
                                                examples=examples, candidates=allowed)
        labels["signatures"][signature] = dict(group=group, evidence=evidence, allowed=allowed)
        if simplified:
            catalog["signatures"][signature]["member_count"] = len(group["members"])
            labels["signatures"][signature]["represented"] = represented
    return canonical(catalog), labels


def prepare_groups(groups, definitions, runtime_identity):
    for group in groups:
        candidates, crowded = recall(group, definitions)
        group.update(candidates=candidates, blocked_reason=(
            "CANDIDATES_OVER_BUDGET" if crowded else "NO_SUPPORTED_SHAPE"
            if group["kind"] is None or not group["members"][0]["surface"] else None))
        basis = {k: v for k, v in group.items() if k != "basis_sha256"}
        group["basis_sha256"] = digest([basis, runtime_identity, MATERIAL_CONTEXT_VERSION])
    return groups


def batches(groups, runtime_identity):
    result, oversized = [], []
    # Short shared lexical neighborhoods keep like surfaces and slot shapes nearby.
    groups = sorted(groups, key=lambda g: (
        g["kind"], g["members"][0]["shape"].get("object_kind", ""),
        [c["definition"]["definition_ref"] for c in g["candidates"]],
        g["members"][0]["surface"].casefold(), g["alignment_signature_ref"],
    ))
    if runtime_identity.get("alignment_contract") == SIMPLIFIED:
        return _pack(groups, runtime_identity)
    chunks = list(batched(groups, MAX_GROUPS))
    while chunks:
        material_and_labels = [materials(chunk) for chunk in chunks]
        counts = tokens([material for material, _ in material_and_labels])
        smaller = []
        for chunk, (material, labels), count in zip(chunks, material_and_labels, counts, strict=True):
            if count <= MAX_MATERIAL_TOKENS:
                result.append(dict(batch_ref=ref("ontology_batch", [
                    runtime_identity, [g["basis_sha256"] for g in chunk], digest(material)]),
                    material=material, material_tokens=count, labels=labels))
            elif len(chunk) == 1:
                oversized.append(chunk[0])
            else:
                middle = len(chunk) // 2
                smaller.extend((chunk[:middle], chunk[middle:]))
        chunks = smaller
    return result, oversized


def _batch(groups, runtime_identity, material, labels, count):
    pin = sha(material)
    return dict(batch_ref=ref("ontology_batch", [runtime_identity, [g["basis_sha256"] for g in groups], pin]),
                material_sha256=pin, material=material, material_tokens=count, labels=labels)


def _pack(groups, runtime_identity):
    pending, result, oversized = list(groups), [], []
    while pending:
        windows = [pending[:n] for n in range(1, min(len(pending), MAX_GROUPS) + 1)]
        proposals = [materials(window) for window in windows]
        counts = tokens([material for material, _ in proposals])
        fits = [i for i, count in enumerate(counts) if count <= MAX_MATERIAL_TOKENS]
        if fits:
            best = fits[-1]
            result.append(_batch(windows[best], runtime_identity, *proposals[best], counts[best]))
            del pending[:best + 1]
            continue
        group = pending.pop(0)
        cohorts = representative_cohorts(group)
        if len(cohorts) == 1:
            oversized.append(group)
            continue
        # The material ceiling can separate observed semantic contexts, never an arbitrary member count.
        pieces = []
        for members in cohorts:
            child = {**group, "members": members,
                     "alignment_signature_ref": ref("signature_context", [
                         group["alignment_signature_ref"], [m["target"] for m in members]])}
            child["basis_sha256"] = digest([group["basis_sha256"], child["alignment_signature_ref"]])
            pieces.append(child)
        pending[:0] = pieces
    return result, oversized


def refresh_batch(batch, definitions, runtime_identity):
    """Freeze candidates from already-settled slots, preserving the original budget."""
    groups = [dict(entry["group"]) for entry in batch["labels"]["signatures"].values()]
    if not definitions:
        return batch
    revised = prepare_groups(groups, definitions, runtime_identity)
    if all(a["basis_sha256"] == b["group"]["basis_sha256"]
           for a, b in zip(revised, batch["labels"]["signatures"].values(), strict=True)):
        return batch
    material, labels = materials(revised)
    count = tokens([material])[0]
    return _batch(revised, runtime_identity, material, labels, count) if count <= MAX_MATERIAL_TOKENS else batch
