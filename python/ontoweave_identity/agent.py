"""Identity evidence packaging and individually settled short-label judgments."""

import re
from decimal import Decimal, InvalidOperation
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Event
from time import perf_counter

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require, sha
from ontoweave_extraction.planner import tokens
from .input import _sequence, name_key, ref, source_key
from .judgment_cache import judgment_key, read_verdicts

LABELS = {"同一": "SAME", "不同": "DIFFERENT", "无法判断": "UNKNOWN"}
JUDGMENT_CONTRACT = "ontoweave-identity-judgment/2"
LEGACY_CONTRACT = "ontoweave-identity-judgment/1"
LINE = re.compile(r"^(候选|判断|置信度|依据|证据)\s*[:：]\s*(.*?)\s*$")
INTRO = """$ontoweave-entity-resolution-v1
候选材料已完整提供。依据下列材料比较每对所指，直接交付候选、判断、置信度（0 至 1）、依据、证据短标签。仅在需要重新核对时使用读取工具。
"""


def _excerpt(text, names, length=260, focus=None):
    matches = [m.start() for name in names if (m := re.search(re.escape(name), text, re.IGNORECASE))]
    position = focus if focus is not None else min(matches, default=0)
    start = max(0, position - 65) if len(text) > length else 0
    end = min(len(text), start + length)
    excerpt = ("[…] " if start else "") + text[start:end] + (" […]" if end < len(text) else "")
    return excerpt, start, end


def _fact_location(text, fact):
    candidate = fact["candidate"]
    value = candidate.get("value_raw") or ""
    if len(value) >= 8:
        match = re.search(re.escape(value), text, re.IGNORECASE)
        if match:
            exact = (candidate.get("value_kind") in {"客体", "文本值"}
                     and len(_sequence(value)) >= 2 and bool(re.search(r"[^\W\d_]", value)))
            return match.start(), exact
    digits = re.match(r"^([0-9]{1,18})(?:$|(?=[\u3400-\u9fff]))", value)
    if digits:
        raw_number = digits[1]
        number = int(raw_number)
        variants = [raw_number, f"{number:,}"]
        for divisor, unit in ((1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")):
            if number >= divisor and number % divisor == 0:
                variants.append(f"{number // divisor} {unit}")
        pattern = r"(?<![\w.])(?:" + "|".join(re.escape(v) for v in variants) + r")(?![\w.])"
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.start(), False
    for segment in re.findall(r"[a-zA-Z][a-zA-Z\s,-]{10,}", value):
        match = re.search(re.escape(segment.strip()), text, re.IGNORECASE)
        if match:
            return match.start(), False
    return None, False


def _profile_material(profile):
    names = profile["names"] + profile["aliases"]
    facts = defaultdict(list)
    for fact in profile["statements"]:
        for source in fact["source_refs"]:
            facts[source_key(source)].append(fact)
    entries = []
    for source in profile["sources"]:
        for fact in facts[source_key(source)]:
            position, exact = _fact_location(source["text"], fact)
            entries.append((0 if exact else 1 if position is not None else 3, source, fact, position, exact))
        entries.append((2, source, None, None, False))
    evidence = []
    for _, source, fact, position, exact in sorted(entries, key=lambda row: row[0])[:5]:
        excerpt, start, end = _excerpt(source["text"], names, focus=position)
        item = dict(source_ref=list(source_key(source)), precision=source["precision"],
                    text_sha256=sha(source["text"]), excerpt=excerpt,
                    source_excerpt_range=dict(start=start, end=end, coordinate="UNIT_CODEPOINTS"))
        statement = None
        if fact:
            item.update(statement_ref=fact["statement_ref"], fact_anchor=position)
            if exact:
                item["literal_fact_key"] = [
                    name_key(fact["candidate"].get("predicate") or ""),
                    name_key(fact["candidate"].get("value_raw") or ""),
                ]
            statement = _excerpt(" ".join(fact["record"].split()), names, 180)[0]
        evidence.append((item, statement))

    def identifier_text(item):
        validity = item.get("validity")
        period = " 至 ".join(map(str, validity)) if validity else "时间未确认"
        constraint = "终身唯一" if item.get("lifetime_unique") else "排他编号" if item.get("exclusive") else "唯一性适用条件待核对"
        return f"{item['namespace']} / {item['scope']} / {item['value']}（{period}，{constraint}）"

    summary = (f"名称 {' / '.join(profile['names'])}，别名 {' / '.join(profile['aliases'])}，"
               f"类型 {' / '.join(profile['type_observations'])}")
    if profile.get("identifiers"):
        summary += "，来源限定编号 " + "；".join(identifier_text(item) for item in profile["identifiers"])
    if profile.get("local_only"):
        summary += "，身份以当前来源为限"
    if profile.get("insufficient"):
        summary += "，名称对应对象仍有歧义"
    return summary, evidence


def material_for(pairs, *, profile_cache=None):
    """Render one profile and one source excerpt per distinct input per batch."""
    profile_cache = {} if profile_cache is None else profile_cache
    profiles, excerpts, labels, comparisons = {}, {}, {}, []
    evidence_count = 0
    for ordinal, pair in enumerate(pairs, 1):
        pair_label = f"P{ordinal:03d}"
        objects, bound = [], {}
        for side, short_side in (("left", "L"), ("right", "R")):
            profile = pair[side]
            key = (pair[f"{side}_ref"], ref("identity_profile_basis", profile))
            if key not in profiles:
                if key not in profile_cache:
                    profile_cache[key] = _profile_material(profile)
                summary, evidence = profile_cache[key]
                tag = f"O{len(profiles) + 1:02d}"
                lines, tags = [f"对象 {tag}：{summary}"], {}
                for item, statement in evidence:
                    region = (tuple(item["source_ref"]), item["text_sha256"],
                              item["source_excerpt_range"]["start"], item["source_excerpt_range"]["end"])
                    if region not in excerpts:
                        u = f"U{len(excerpts) + 1:03d}"
                        excerpts[region] = f"{u}（来源精度 {item['precision']}）：{item['excerpt']}"
                    u = excerpts[region].split("（", 1)[0]
                    evidence_count += 1
                    label = f"E{evidence_count:03d}"
                    lines.append(f"  {label} → {u}" + (f"；关联陈述 {statement}" if statement else ""))
                    tags[label] = item
                profiles[key] = tag, "\n".join(lines), tags
            tag, _, tags = profiles[key]
            objects.append(tag)
            bound.update({label: dict(item, side=short_side) for label, item in tags.items()})
        # A correctly constructed pair always has two distinct object references.
        require(objects[0] != objects[1], "IDENTITY_CANDIDATE_IDENTICAL_SIDE")
        reasons = "、".join(pair.get("reasons") or [])
        constraint = "；适用约束：已有人工不同决定" if pair["prior_different"] else ""
        comparisons.append(f"候选 {pair_label}：{objects[0]} 与 {objects[1]}；提出原因 {reasons}{constraint}")
        labels[pair_label] = dict(review_ref=pair["review_ref"], evidence_sha256=pair["evidence_sha256"], evidence=bound)
    instructions = "只引用候选双方对象下的 E 标签。U 标签定位共享原文，不能替代 E 标签。"
    sections = ["\n".join(row[1] for row in profiles.values()),
                "\n".join(excerpts.values()), "\n".join(comparisons)]
    return INTRO + instructions + "\n\n" + "\n\n".join(sections), labels


def make_batches(pairs, runtime, library, continuation=None, *, profile_cache=None):
    batches, too_large = [], []
    rest = list(pairs)
    profile_cache = {} if profile_cache is None else profile_cache
    while rest:
        proposed = [rest[:size] for size in range(1, min(8, len(rest)) + 1)]
        materials = [material_for(p, profile_cache=profile_cache) for p in proposed]
        counts = tokens([p for p, _ in materials])
        eligible = [i for i, count in enumerate(counts) if count <= 5000]
        if not eligible:
            too_large.append(rest.pop(0)["review_ref"])
            continue
        i = eligible[-1]
        prompt, labels = materials[i]
        binding = [library, labels, sha(prompt), runtime.identity]
        if continuation is not None:
            binding.append(continuation)
        key = ref("identity_batch", [JUDGMENT_CONTRACT, *binding])
        batches.append(dict(batch_ref=key, prompt=prompt, prompt_sha256=sha(prompt), labels=labels,
                            input_tokens=counts[i], tokenizer="cl100k_base", pair_count=len(labels),
                            judgment_contract=JUDGMENT_CONTRACT))
        del rest[:i + 1]
    return batches, too_large


def _score(entries):
    if not entries:
        return None, "MISSING"
    if len(entries) != 1 or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", entries[0]):
        return None, "INVALID"
    try:
        value = Decimal(entries[0])
    except InvalidOperation:
        return None, "INVALID"
    if not value.is_finite() or not Decimal(0) <= value <= Decimal(1):
        return None, "INVALID"
    return float(value), "VALID"


def parse_judgments(messages, labels, *, contract=JUDGMENT_CONTRACT):
    blocks, errors = defaultdict(list), []
    for message in messages:
        current = None
        raw = message["text"].encode("utf-8")
        offset = 0
        for line in raw.splitlines(keepends=True):
            start = offset
            offset += len(line)
            text = line.decode("utf-8").strip()
            if not text or text.startswith("```"):
                continue
            match = LINE.fullmatch(text)
            if match and match[1] == "候选":
                current = dict(fields=defaultdict(list), raw_sha256=sha(raw), message_id=message["message_id"],
                               byte_start=start, byte_end=offset, malformed=False)
                blocks[match[2]].append(current)
            elif current is not None:
                current["byte_end"] = offset
                if match and not (contract == LEGACY_CONTRACT and match[1] == "置信度"):
                    current["fields"][match[1]].append(match[2])
                else:
                    current["malformed"] = True
            else:
                errors.append(dict(code="UNBOUND_LINE", byte_start=start, raw_sha256=sha(raw)))
    answers = {}
    for key, bound in labels.items():
        entries = blocks.pop(key, [])
        if len(entries) != 1:
            code = "MISSING_JUDGMENT" if not entries else "DUPLICATE_JUDGMENT"
            answers[bound["review_ref"]] = dict(label=key, code=code)
            continue
        entry = entries[0]
        fields = entry.pop("fields")
        malformed = entry.pop("malformed")
        judgment, reason = fields["判断"], fields["依据"]
        evidence = fields["证据"]
        if contract == JUDGMENT_CONTRACT:
            evidence = [tag.strip() for line in evidence for tag in re.split(r"[,、，]", line)]
        tags = bound["evidence"]
        code = None
        if malformed or len(judgment) != 1 or judgment[0] not in LABELS or len(reason) != 1 or not reason[0]:
            code = "MALFORMED_JUDGMENT"
        elif any(tag not in tags for tag in evidence):
            code = "OUT_OF_PAIR_EVIDENCE"
        elif judgment[0] != "无法判断" and {tags[t]["side"] for t in evidence} != {"L", "R"}:
            code = "TWO_SIDED_EVIDENCE_REQUIRED"
        answer = dict(label=key, evidence_sha256=bound["evidence_sha256"], **entry)
        if code:
            answer["code"] = code
        else:
            answer.update(judgment=LABELS[judgment[0]], reason=reason[0],
                          evidence_refs=[dict(label=t, **tags[t]) for t in dict.fromkeys(evidence)])
            if contract == JUDGMENT_CONTRACT:
                score, qualification = _score(fields["置信度"])
                answer.update(contract=contract, confidence=score, confidence_status=qualification,
                              confidence_raw=fields["置信度"][0] if qualification == "VALID" else None)
        answers[bound["review_ref"]] = answer
    errors.extend(dict(code="UNKNOWN_CANDIDATE", label=k, count=len(rows)) for k, rows in blocks.items())
    return answers, errors


def judge(store, prepared, pairs, runtime, *, prior_batches=(), continuation=None, publisher=False):
    from .storage import library_lock

    require(1 <= runtime.concurrency <= 4, "IDENTITY_AGENT_CONCURRENCY_INVALID")
    library, prepared_ref = prepared["library_ref"], prepared["prepared_ref"]
    if not pairs and not prior_batches:
        return {}, [], "NO_PENDING_PAIRS"
    keyed = {judgment_key(pair, runtime): pair for pair in pairs}
    require(len(keyed) == len(pairs), "IDENTITY_DUPLICATE_JUDGMENT_BASIS")
    keys_by_review = {p["review_ref"]: k for k, p in keyed.items()}
    with store.transaction(readonly=True) as (q, _):
        cached, blocked = read_verdicts(q, library, keyed, continuation=continuation is not None)
    fresh = [p for p in pairs if p["review_ref"] not in cached and p["review_ref"] not in blocked]
    halted = Event()
    if any(code in ("UNKNOWN_HOLD", "FAILED", "INFLIGHT_JUDGMENT") for code in blocked.values()):
        halted.set()
    profile_cache = {}
    batches, oversized = make_batches(fresh, runtime, library, continuation, profile_cache=profile_cache)
    if continuation is not None:
        for batch in batches:
            batch["continuation_ref"] = continuation

    def worker(batch):
        started = perf_counter()
        local = {keys_by_review[b["review_ref"]]: keyed[keys_by_review[b["review_ref"]]]
                 for b in batch["labels"].values()}
        with store.transaction() as (q, _):
            library_lock(q, library, publisher=publisher)
            if continuation is None:
                resume = q("""SELECT 1 FROM identity_v1.continuations
                              WHERE library_ref=%s AND prepared_ref=%s AND status='STARTED'""",
                           [library, prepared_ref]).fetchone()
                if resume:
                    return None, {}, {}, True
            # Recheck and claim by semantic key under the same lock. A different
            # prepared run or different batch partition cannot duplicate dispatch.
            late_cached, late_blocked = read_verdicts(q, library, local, continuation=continuation is not None)
            if any(code in ("UNKNOWN_HOLD", "FAILED", "INFLIGHT_JUDGMENT") for code in late_blocked.values()):
                halted.set()
            remaining = [p for p in local.values()
                         if p["review_ref"] not in late_cached and p["review_ref"] not in late_blocked]
            if not remaining or halted.is_set():
                late_blocked.update({p["review_ref"]: "HELD_AFTER_TECHNICAL_FAILURE" for p in remaining})
                return None, late_cached, late_blocked, False
            if len(remaining) != len(local):
                replanned, over = make_batches(remaining, runtime, library, continuation,
                                               profile_cache=profile_cache.copy())
                require(len(replanned) == 1 and not over, "IDENTITY_CACHE_SUBSET_BUDGET_CHANGED")
                batch = replanned[0]
                if continuation is not None:
                    batch["continuation_ref"] = continuation
            key = batch["batch_ref"]
            batch["judgment_keys"] = {keys_by_review[p["review_ref"]]: p["review_ref"] for p in remaining}
            timestamp = q("SELECT clock_timestamp() AS ts").fetchone()["ts"].isoformat()
            insert = q("""INSERT INTO identity_v1.batch_results(library_ref,batch_ref,prepared_ref,status,payload)
                          VALUES(%s,%s,%s,'STARTED',%s) ON CONFLICT DO NOTHING RETURNING batch_ref""",
                       [library, key, prepared_ref, Jsonb({**batch, "started_at": timestamp})]).fetchone()
            require(insert, "IDENTITY_BATCH_CLAIM_CONFLICT")
        try:
            result = runtime.invoke(store, batch, halted)
            messages = result.get("messages", [])
            technical = result["status"]
            if technical in ("FAILED", "UNKNOWN_HOLD"):
                halted.set()
            if technical in ("COMPLETED", "PARTIAL"):
                items, errors = parse_judgments(messages, batch["labels"], contract=batch["judgment_contract"])
                state = "PARTIAL" if errors or any("code" in item for item in items.values()) else "COMPLETED"
            else:
                state = technical
                items = {bound["review_ref"]: dict(code=technical) for bound in batch["labels"].values()}
                errors = []
        except Exception as exc:
            halted.set()
            result = dict(status="UNKNOWN_HOLD", error=getattr(exc, "code", None) or type(exc).__name__)
            state = "UNKNOWN_HOLD"
            items = {bound["review_ref"]: dict(code=state) for bound in batch["labels"].values()}
            errors = []
        payload = dict(**batch, status=state, judgments=items, diagnostics=errors,
                       native=result, wall_ms=(perf_counter() - started) * 1000)
        with store.transaction() as (q, _):
            q("""UPDATE identity_v1.batch_results SET status=%s,payload=%s
                 WHERE library_ref=%s AND batch_ref=%s AND status='STARTED'""", [state, Jsonb(payload), library, key])
        return payload, late_cached, late_blocked, False

    rows = [*prior_batches]
    transient = []
    with ThreadPoolExecutor(max_workers=runtime.concurrency) as pool:
        futures = {pool.submit(worker, batch): batch for batch in batches}
        for future in as_completed(futures):
            row, hits, hold, concurrent = future.result()
            cached.update(hits)
            blocked.update(hold)
            if row:
                rows.append(row)
            elif concurrent or any(code == "HELD_AFTER_TECHNICAL_FAILURE" for code in hold.values()):
                transient.append(dict(batch_ref=futures[future]["batch_ref"], status="HELD_AFTER_TECHNICAL_FAILURE",
                                      **({"concurrent_continuation": True} if concurrent else {})))
    rows.extend(transient)
    rows.sort(key=lambda r: r["batch_ref"])
    answers = {key: dict(code="MATERIAL_OVER_TOKEN_BUDGET") for key in oversized}
    answers.update(cached)
    answers.update({key: (dict(code="UNKNOWN_HOLD", concurrent_judgment=True)
                          if code == "INFLIGHT_JUDGMENT" else dict(code=code))
                    for key, code in blocked.items()})
    for row in rows:
        answers.update(row.get("judgments") or {
            b["review_ref"]: dict(code=row["status"])
            for b in row.get("labels", {}).values()
        })
    states = {r["status"] for r in rows} | set(blocked.values())
    status = ("UNKNOWN_HOLD" if states & {"UNKNOWN_HOLD", "INFLIGHT_JUDGMENT"} else "FAILED" if "FAILED" in states
              else "PARTIAL" if states & {"PARTIAL", "HELD_AFTER_TECHNICAL_FAILURE", "KNOWN_JUDGMENT_GAP"} or oversized
              else "COMPLETED")
    return answers, rows, status
