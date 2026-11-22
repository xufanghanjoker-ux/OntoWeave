"""Evidence snapshots, profile recall, and constrained identity grouping."""

import re
from collections import defaultdict
from datetime import date
from difflib import SequenceMatcher
from itertools import combinations, product

from ontoweave_cq.store import require
from ontoweave_cq_similarity.core import digest
from .input import _sequence, name_key, ref, source_key

STRATEGY = "identity-v1-context-lexical-0.84-top5-20261118"
LOCAL_ONLY = {"description", "anonymous", "category", "描述性对象", "匿名对象", "泛指类别", "集合"}
NEAR_FLOOR = 0.84


def _names(rows):
    names = {r["name_raw"] for r in rows}
    aliases = {a["name_raw"] for r in rows for a in r["alias_observations"]}
    return sorted(names), sorted(aliases - names)


def _identity_keys(rows):
    return [c for o in rows for c in o["identity_claims"] if c.get("reliable_unique")
            and all(c.get(key) for key in ("namespace", "value", "scope", "source_ref"))]


def _period(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    sizes = {len(part) for part in value if isinstance(part, str)}
    if len(sizes) != 1 or any(not isinstance(v, str) for v in value):
        return None
    if not all(re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", v) for v in value):
        return None
    size = next(iter(sizes))
    suffix = {4: "-01-01", 7: "-01", 10: ""}.get(size)
    if suffix is None or value[0] > value[1]:
        return None
    try:
        for boundary in value:
            date.fromisoformat(boundary + suffix)
    except ValueError:
        return None
    return size, value


def _overlap(a, b):
    a, b = _period(a), _period(b)
    return bool(a and b and a[0] == b[0] and max(a[1][0], b[1][0]) <= min(a[1][1], b[1][1]))


def identifier_comparison(left, right):
    same, different = [], []
    for a, b in product(left["identifiers"], right["identifiers"]):
        if not (a.get("reliable_unique") and b.get("reliable_unique")):
            continue
        if (a["namespace"], a["scope"]) != (b["namespace"], b["scope"]):
            continue
        exclusive = bool(a.get("exclusive") and b.get("exclusive"))
        lifetime = a.get("lifetime_unique") and b.get("lifetime_unique")
        overlap = _overlap(a.get("validity"), b.get("validity"))
        one_value_per_identity = (exclusive and a.get("single_value_per_identity", True)
                                  and b.get("single_value_per_identity", True))
        if a["value"] == b["value"] and (lifetime or (exclusive and overlap)):
            same.append([a, b])
        elif a["value"] != b["value"] and one_value_per_identity and overlap:
            different.append([a, b])
    return same, different


def profile_views(homes, occurrences, statements):
    grouped = defaultdict(list)
    for occurrence_ref, entity_ref in homes.items():
        grouped[entity_ref].append(occurrences[occurrence_ref])
    result = {}
    for entity_ref, objects in sorted(grouped.items()):
        rows = sorted(objects, key=lambda o: (o["role"] != "DECLARATION", o["occurrence_ref"]))
        names, aliases = _names(rows)
        facts = sorted({s for o in rows for s in o["statement_refs"]})
        sources = {tuple(source_key(s)): s for o in rows for s in o["source_refs"] if s["precision"] == "UNIT"}
        result[entity_ref] = dict(
            entity_ref=entity_ref, display_name=rows[0]["name_raw"], names=names, aliases=aliases,
            type_observations=sorted({t["type_raw"] for o in rows for t in o["type_observations"]}),
            occurrences=[o["occurrence_ref"] for o in rows], statement_refs=facts,
            statements=[dict(statement_ref=s, record=statements[s]["record"]["raw_utf8"],
                             candidate=statements[s]["candidate"], source_refs=statements[s]["source_refs"])
                        for s in facts],
            sources=list(sources.values()), identifiers=_identity_keys(rows),
            local_only=any(name_key(o.get("category_raw") or "") in LOCAL_ONLY for o in rows),
            insufficient=any("IDENTITY_CONTEXT_INSUFFICIENT" in o["warnings"] for o in rows),
            competing_declaration_refs=sorted({d for o in rows for d in o.get("competing_declarations", [])}),
        )
    return result


def _explicit_alias(left, right):
    if left["local_only"] or right["local_only"] or left["insufficient"] or right["insufficient"]:
        return []
    matches = []
    for source_profile, other in ((left, right), (right, left)):
        for name, alias in product(source_profile["names"], source_profile["aliases"]):
            if alias in source_profile["names"] or alias not in other["names"] or alias == name:
                continue
            # Require an explicit linking phrase present verbatim, and the alternate name in the other source.
            separator = r"(?:\s*[,，]?\s*(?:亦称|又称|简称(?:为)?|曾用名(?:为)?|also known as|abbreviated as|formerly known as)\s*)"
            expression = re.compile(re.escape(name) + separator + re.escape(alias) + r"(?!\w)", re.IGNORECASE)
            for a, b in product(source_profile["sources"], other["sources"]):
                match = expression.search(a["text"])
                other_match = re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", b["text"], re.IGNORECASE)
                if match and other_match and source_key(a) != source_key(b):
                    matches.append(dict(source_keys=[list(source_key(a)), list(source_key(b))],
                                        quote=match.group(), alias=alias))
    return matches


def _descriptive_context(left, right, a, b):
    first, second = sorted((_sequence(a), _sequence(b)), key=len)
    if not 2 <= len(first) < len(second) or not set(first) <= set(second):
        return False
    it = iter(second)
    if not all(token in it for token in first):
        return False
    if sum(map(len, first)) < 5:
        return False
    source_overlap = {source_key(s) for s in left["sources"]} & {source_key(s) for s in right["sources"]}
    type_overlap = set(left["type_observations"]) & set(right["type_observations"])
    shared_value = {s["candidate"].get("value_raw") for s in left["statements"]} & {
        s["candidate"].get("value_raw") for s in right["statements"]
    }
    distinctive = any(isinstance(v, str) and len(v) >= 8 and not v.isdigit() for v in shared_value)
    return bool(source_overlap or (type_overlap and distinctive))


def recall(profiles, new_refs, vector_hits=None):
    exact, identifiers, pairs = defaultdict(set), defaultdict(set), defaultdict(set)
    truncation = 0
    new_refs = set(new_refs)
    names = {e: p["names"] + p["aliases"] for e, p in profiles.items()}
    for entity, profile in profiles.items():
        for name in names[entity]:
            exact[name_key(name)].add(entity)
        for claim in profile["identifiers"]:
            identifiers[(claim["namespace"], claim["scope"], claim["value"])].add(entity)
    for entity in sorted(new_refs):
        profile = profiles[entity]
        for key in {name_key(n) for n in names[entity]}:
            for other in exact[key] - {entity}:
                pairs[tuple(sorted((entity, other)))].add("EXACT_NAME_OR_ALIAS")
        for claim in profile["identifiers"]:
            for other in identifiers[(claim["namespace"], claim["scope"], claim["value"])] - {entity}:
                pairs[tuple(sorted((entity, other)))].add("UNIQUE_IDENTIFIER")
    exact_pairs = set(pairs)
    for entity in sorted(new_refs):
        profile = profiles[entity]
        for other in (vector_hits or {}).get(entity, []):
            if other != entity and other in profiles:
                pairs[tuple(sorted((entity, other)))].add("ENTITY_NAME_VECTOR")
        if profile["local_only"]:
            continue
        near = {}
        for other, target in profiles.items():
            pair = tuple(sorted((entity, other)))
            if other == entity or target["local_only"] or pair in exact_pairs:
                continue
            forms = list(product(names[entity], names[other]))
            if any(_descriptive_context(profile, target, a, b) for a, b in forms):
                near[other] = (2.0, "DESCRIPTIVE_CONTEXT")
                continue
            score = max((SequenceMatcher(None, name_key(a), name_key(b), autojunk=False).ratio()
                         for a, b in forms if min(len(a), len(b)) >= 4), default=0)
            if score >= NEAR_FLOOR:
                near[other] = (score, "LEXICAL_NEAR")
        truncation += max(0, len(near) - 5)
        for other in sorted(near, key=lambda other: (-near[other][0], other))[:5]:
            pairs[tuple(sorted((entity, other)))].add(near[other][1])
    result = []
    for (left, right), reasons in sorted(pairs.items()):
        a, b = profiles[left], profiles[right]
        same, different = identifier_comparison(a, b)
        direct = _explicit_alias(a, b) if "EXACT_NAME_OR_ALIAS" in reasons else []
        snapshot = dict(left=a, right=b, reasons=sorted(reasons), reliable_same=same,
                        reliable_different=different, direct_alias=direct)
        # Receipt history is keyed to the evidence actually compared, rather than the run that recalled it.
        evidence = digest(snapshot)
        result.append(dict(left_ref=left, right_ref=right, evidence_sha256=evidence, strategy=STRATEGY,
                           review_ref=ref("identity_review", [left, right, evidence, STRATEGY]), **snapshot))
    return result, truncation


def active_decisions(decisions):
    disabled = set()
    active = []
    for decision in reversed(decisions):
        if decision["decision_ref"] in disabled:
            continue
        active.append(decision)
        disabled.update(decision.get("supersedes", []))
    return list(reversed(active))


class Groups:
    """Replay durable evidence and keep cannot-links between all member profiles."""

    def __init__(self, homes, decisions):
        self.events = active_decisions(decisions)
        # An old decision can connect surviving evidence through a retired home.
        homes = set(homes) | {event[key] for event in self.events for key in ("left_ref", "right_ref")}
        self.representative = {home: home for home in homes}
        self.members = {home: {home} for home in homes}
        self.provenance = {}
        self.different = [d for d in self.events if d["action"] == "DIFFERENT"]
        for event in self.events:
            if event["action"] == "SAME":
                self.join(event["left_ref"], event["right_ref"], event["decision_ref"],
                          event.get("survivor_ref"))
        require(not any(self.representative[d["left_ref"]] == self.representative[d["right_ref"]]
                        for d in self.different), "IDENTITY_GROUP_CONTAINS_DIFFERENT")

    def constraints(self, left, right):
        a = self.representative[left]
        b = self.representative[right]
        return [d for d in self.different
                if {self.representative[d["left_ref"]], self.representative[d["right_ref"]]} == {a, b}]

    def join(self, left, right, decision_ref, survivor_ref=None):
        a, b = sorted((self.representative[left], self.representative[right]))
        if a == b:
            return
        if self.representative.get(survivor_ref) == b:
            a, b = b, a
        require(not self.constraints(a, b), "IDENTITY_GROUP_DIFFERENT_CONSTRAINT")
        moved = self.members.pop(b)
        self.members[a].update(moved)
        for home in moved:
            self.representative[home] = a
            self.provenance[home] = decision_ref
