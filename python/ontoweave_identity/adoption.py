"""Execution eligibility for evidence-bound identity judgments."""

from decimal import Decimal, InvalidOperation
from math import isfinite
import re

from ontoweave_cq.store import sha

from .input import _sequence, name_key, source_key
from .publication import _graph_at

ADOPTION_POLICY = "identity-utopia-execution-gate/2"
CONFIDENCE_THRESHOLD = Decimal("0.8")
MAX_AUTO_STATEMENTS = 12
SCOPE_WORDS = frozenset(("edition", "version", "subsidiary", "division", "branch", "parent",
                         "annex", "department", "inc", "ltd", "corporation", "group", "incorporated",
                         "character", "protagonist", "role", "actor", "adaptation"))
SCOPE_PHRASES = ("版本", "子公司", "分公司", "部门", "母公司", "附楼", "分部", "集团",
                 "中的", "新版", "初版", "原版", "原著", "角色", "主角", "饰演者", "改编")
CHECKS = ("declared_constraint_collisions", "adopted_derivations", "citation_dependencies")
REASONS = {
    "LEGACY_UNSCORED": "旧判断没有记录模型把握度，保留供复核。",
    "CONFIDENCE_MISSING": "模型没有提供把握度。",
    "CONFIDENCE_INVALID": "模型把握度格式无效。",
    "CONFIDENCE_BELOW_THRESHOLD": "模型记录的把握度低于自动采用阈值。",
    "MODEL_UNCERTAIN": "模型认为现有材料不足以判断身份。",
    "TECHNICAL_JUDGMENT_PENDING": "本对模型结果尚未完成技术结算。",
    "BILATERAL_EVIDENCE_UNAUTHENTICATED": "双方的来源绑定尚未通过核对。",
    "ENTITY_NAME_VECTOR_ONLY": "名称不同，这一对仅由名称向量相似提出。",
    "IDENTITY_SCOPE_RISK": "名称或原文明示的角色、版本或组织作用域需要复核。",
    "KNOWN_CONFLICT": "当前实体组存在不同决定、排他标识或有据冲突。",
    "ALREADY_MAPPED": "双方已指向同一实体。",
    "SCOPED_DIFFERENT_RETAINED": "模型建议在当前来源范围内保持独立。",
    "IMPACT_READ_FAILED": "合并影响读取失败，等待检查恢复。",
    "IMPACT_INCOMPLETE": "当前无法完成合并影响检查。",
    "IMPACT_CONFLICT_OR_DEPENDENCY": "合并会影响已检查的约束、派生或引用。",
    "STATEMENT_SCOPE_TOO_LARGE": "合并范围超过自动采用上限。",
    "AUTO_APPLIED": "达到阈值且通过身份与影响检查。",
    "EVIDENCE_INSUFFICIENT_FOR_AUTO": "旧策略未取得其要求的独立旁证。",
    "IMPACT_INCOMPLETE_OR_NONEMPTY": "旧记录的影响检查未通过。",
}


def confidence_reason(answer):
    if answer.get("contract") != "ontoweave-identity-judgment/2":
        return "LEGACY_UNSCORED"
    state = answer.get("confidence_status")
    if state == "MISSING":
        return "CONFIDENCE_MISSING"
    score = answer.get("confidence")
    if (state != "VALID" or type(score) not in (int, float) or not isfinite(score)
            or not 0 <= score <= 1):
        return "CONFIDENCE_INVALID"
    try:
        decimal = Decimal(answer.get("confidence_raw") or str(score))
        if not decimal.is_finite() or not 0 <= decimal <= 1 or float(decimal) != score:
            return "CONFIDENCE_INVALID"
    except (InvalidOperation, ValueError, TypeError):
        return "CONFIDENCE_INVALID"
    return "CONFIDENCE_BELOW_THRESHOLD" if decimal < CONFIDENCE_THRESHOLD else None


def authenticated_material(review, answer):
    if answer.get("evidence_sha256") != review["evidence_sha256"]:
        return []
    accepted = []
    sides = set()
    for side, key in (("L", "left"), ("R", "right")):
        profile = review[key]
        sources = {source_key(s): s for s in profile["sources"]}
        statements = {s["statement_ref"]: {source_key(unit) for unit in s["source_refs"]}
                      for s in profile["statements"]}
        for evidence in answer.get("evidence_refs", ()):
            if evidence.get("side") != side:
                continue
            location = tuple(evidence.get("source_ref") or ())
            unit = sources.get(location)
            if not unit or evidence.get("precision") != unit["precision"]:
                return []
            if sha(unit["text"]) != evidence.get("text_sha256"):
                return []
            statement = evidence.get("statement_ref")
            if statement is not None and location not in statements.get(statement, set()):
                return []
            sides.add(side)
            accepted.append(evidence)
    return accepted if sides == {"L", "R"} else []


def _scope_tokens(profile):
    terms = set()
    for name in profile["names"]:
        terms.update(word for word in _sequence(name) if word.isdigit() or word in SCOPE_WORDS)
        terms.update(word for word in SCOPE_PHRASES if word in name)
    return terms


def scope_risk(left, right):
    if (left["local_only"] or right["local_only"] or _scope_tokens(left) != _scope_tokens(right)
            or len(left["competing_declaration_refs"]) > 1 or len(right["competing_declaration_refs"]) > 1):
        return True
    for profile in (left, right):
        for name in profile["names"]:
            pattern = r"(?<!\w)(?:two|three|multiple|different) [^.!?]{1,60}(?:named|called) +"
            if any(re.search(pattern + re.escape(name) + r"(?!\w)", s["text"], re.IGNORECASE)
                   for s in profile["sources"]):
                return True
    return False


def candidate_risk(review):
    left, right = review["left"], review["right"]
    a, b = ({name_key(n) for n in p["names"] + p["aliases"]} for p in (left, right))
    if review["reasons"] == ["ENTITY_NAME_VECTOR"] and a.isdisjoint(b):
        return "ENTITY_NAME_VECTOR_ONLY"
    return "IDENTITY_SCOPE_RISK" if scope_risk(left, right) else None


def adoption_record(status, code, impact=None):
    return dict(status=status, reason_code=code, reason=REASONS.get(code), impact=impact, policy=ADOPTION_POLICY)


def impact_check(q, library, version, scope, ports):
    checks = dict(identity_constraints={"status": "READY", "refs": []})
    if len(scope["statement_refs"]) > MAX_AUTO_STATEMENTS:
        return dict(ready=False, reason="STATEMENT_SCOPE_TOO_LARGE", checks=checks)
    if ports is not None and any(p is not None for p in (ports.fact, ports.graph, ports.index, ports.impact)):
        try:
            observed = ports.impact(scope) if ports.impact else {}
        except Exception:
            return dict(ready=False, reason="IMPACT_READ_FAILED", checks=checks)
        if not isinstance(observed, dict):
            observed = {}
        for key in CHECKS:
            candidate = observed.get(key)
            if isinstance(candidate, dict) and candidate.get("status") == "READY" and isinstance(candidate.get("refs"), list):
                checks[key] = candidate
            else:
                checks[key] = dict(status="NOT_VERIFIED", refs=[])
        if any(checks[k]["status"] == "READY" and checks[k]["refs"] for k in CHECKS):
            return dict(ready=False, checks=checks, reason="IMPACT_CONFLICT_OR_DEPENDENCY")
        ready = all(checks[k]["status"] == "READY" for k in CHECKS)
        return dict(ready=ready, checks=checks, reason=None if ready else "IMPACT_INCOMPLETE")
    projection = _graph_at(q, library, version, "STATEMENT", scope["statement_refs"])
    row = q("""SELECT payload FROM identity_v1.active_views WHERE library_ref=%s AND revision=%s""",
            [library, version]).fetchone()
    backends = (row or {}).get("payload", {}).get("index", {}).get("backends")
    ready = (backends == ["PG_ENTITY_NAME", "PG_ENTITY_DOCUMENT"]
             and set(projection) == set(scope["statement_refs"])
             and all(s["interpretation"]["result"] == "OPEN_UNINTERPRETED" for s in projection.values()))
    for key in CHECKS:
        checks[key] = dict(status="READY" if ready else "NOT_VERIFIED", refs=[],
                           scope="IDENTITY_OWNED_PG_OPEN_GRAPH")
    return dict(ready=ready, checks=checks, reason=None if ready else "IMPACT_INCOMPLETE")
