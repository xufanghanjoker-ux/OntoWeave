"""Locate evidence in saved units without treating response offsets as source offsets."""

from functools import lru_cache
import re

MATERIAL_CONTEXT_VERSION = "ontology-material-context/2"
_BOUNDARY = re.compile(r"""[。！？!?]+[”’"')）\]]*|\.[”’"')）\]]*(?=\s|$)|(?:\r?\n)+""")
_ABBREVIATION = re.compile(r"(?i)(?:\b(?:mr|mrs|ms|dr|prof|st|fig|vs|e\.g|i\.e)\.|\b(?:[a-z]\.){2,}|\b[A-Z]\.)$")
_SCOPE_CUE = re.compile(
    r"(?i)\b(?:no|not|never|neither|only|except|unless|without|denied|according to|"
    r"as of|since|until|during|after|before|in [12]\d{3}|said|reported|applies to)\b"
    r"|未|没有|否认|仅|只限|除外|截至|从未|按照|根据|据.+?(?:称|说)|期间|适用于"
)
_LINK_CUE = re.compile(
    r"(?i)^(?:according to\b|as of\b|since\b|until\b|during\b|before\b|after\b|in [12]\d{3}\b|"
    r"it\b|they\b|this\b|these\b|that\b|those\b|however\b|only\b|"
    r"根据|据|截至|当时|其|该|这|此|它|不过|然而|但|仅|期间)"
)

_WORDS = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9]+", re.IGNORECASE)
_STOP = frozenset("""
a an and at be been being by did do does for from had has have he her here him his how i in is it its
of on or our said she that the their them then there these they this those to was we were what
when where which who will with would you your
""".split())


@lru_cache(maxsize=128)
def _segments(text):
    def trimmed(start, end):
        while start < end and text[start].isspace():
            start += 1
        while start < end and text[end - 1].isspace():
            end -= 1
        return (start, end) if start < end else None

    spans = []
    start = 0
    for boundary in _BOUNDARY.finditer(text):
        end = boundary.end()
        if boundary.group().startswith(".") and end < len(text) and _ABBREVIATION.search(text, start, end):
            continue
        span = trimmed(start, end)
        if span:
            spans.append(span)
        start = end
    final = trimmed(start, len(text))
    if final:
        spans.append(final)
    return tuple(spans)


@lru_cache(maxsize=4096)
def _literal_positions(text, phrase):
    phrase = phrase.strip()
    if not phrase or not any(ch.isalnum() for ch in phrase):
        return ()
    pattern = r"\s+".join(re.escape(part) for part in phrase.split())
    # Latin token boundaries avoid e.g. treating 'Ann' inside 'Annex' as evidence.
    if re.match(r"[A-Za-z0-9_]", phrase):
        pattern = r"(?<!\w)" + pattern
    if re.search(r"[A-Za-z0-9_]$", phrase):
        pattern += r"(?!\w)"
    return tuple(match.span() for match in re.finditer(pattern, text, re.IGNORECASE))


def _trusted_location(source, text):
    quote = source.get("quote")
    span = source.get("source_excerpt_range") or source.get("span")
    if isinstance(span, dict):
        start, end = (span.get(k) for k in ("start", "end"))
        coordinate = span.get("coordinate")
        if type(start) is int and type(end) is int and 0 <= start < end:
            if coordinate == "UNIT_UTF8_BYTES":
                encoded = text.encode("utf-8")
                if end <= len(encoded):
                    try:
                        start, end = len(encoded[:start].decode()), len(encoded[:end].decode())
                    except UnicodeDecodeError:
                        start = end = 0
                else:
                    start = end = 0
            if coordinate in {"UNIT_CODEPOINTS", "UNIT_UTF8_BYTES"} and 0 <= start < end <= len(text):
                if text[start:end].strip() and (not quote or quote == text[start:end]):
                    return (start, end), "SAVED_UNIT_SPAN"
    if isinstance(quote, str) and quote.strip():
        start = text.find(quote)
        if start >= 0 and text.find(quote, start + 1) < 0:
            return (start, start + len(quote)), "UNIQUE_SAVED_QUOTE"
    return None, None


def _values(candidate):
    primary = {
        "subject": candidate.get("subject"),
        "property": candidate.get("relation_phrase") or candidate.get("predicate"),
        "value": candidate.get("value_raw"),
    }
    scoped = [entry.get("value") for field in ("qualifiers", "times") for entry in candidate.get(field, [])]
    return ({key: value for key, value in primary.items() if isinstance(value, str) and value.strip()},
            tuple(dict.fromkeys(value for value in scoped if isinstance(value, str) and value.strip())))


def _score(primary, modifiers, span):
    start, end = span
    hits = {key: [(a, b) for a, b in positions if start <= a < b <= end] for key, positions in primary.items()}
    keys = [key for key, positions in hits.items() if positions]
    distinct = any(a1 >= b2 or a2 >= b1 for i, left in enumerate(keys) for right in keys[i + 1:]
                   for a1, b1 in hits[left] for a2, b2 in hits[right])
    if not distinct:
        return None
    return len(keys), "subject" in keys and "value" in keys, sum(
        any(start <= a < b <= end for a, b in positions) for positions in modifiers)


def _words(text):
    return {word.casefold() for word in _WORDS.findall(text)
            if len(word) >= 3 and word.casefold() not in _STOP}


def _term_focus(text, segments, primary_values, modifier_values):
    """Find a unique segment with informative overlap across independent slots."""
    words = [_words(text[a:b]) for a, b in segments]
    slot_words = {key: _words(value) for key, value in primary_values.items()}
    modifiers = set().union(*map(_words, modifier_values))
    frequencies = {word: sum(word in row for row in words)
                   for word in set().union(*slot_words.values(), modifiers)}
    ranked = []
    for index, row in enumerate(words):
        hits = {key: row.intersection(values) for key, values in slot_words.items()}
        named = hits.get("subject", set()) | hits.get("value", set())
        cross_slot = any(x != y for key in ("subject", "value") for x in hits.get(key, ())
                         for other, values in hits.items() if other != key for y in values)
        shared = set().union(*hits.values())
        informative = {word for word in shared if frequencies[word] <= 2}
        if not (named and cross_slot and len(informative) >= 2):
            continue
        bonus = len(row.intersection(modifiers) - shared)
        ranked.append(((len(informative), len(shared), bonus), index))
    if not ranked:
        return "NO_RELIABLE_ANCHOR", None
    score = max(value for value, _ in ranked)
    best = [index for value, index in ranked if value == score]
    return ("DISTINCTIVE_TERM_CONTEXT", best[0]) if len(best) == 1 else ("AMBIGUOUS_ANCHOR", None)


def source_context(source, candidate):
    """Return a source-local location decision, with ordered exact unit slices.

    A lexical match locates context for comparison. It does not certify the claim
    or establish an exact documentary statement span.
    """
    if source.get("precision") != "UNIT":
        return "TASK_ONLY", ()
    text = source["text"]
    segments = _segments(text)
    if not segments:
        return "NO_SOURCE_SEGMENT", ()
    anchor, method = _trusted_location(source, text)
    primary_values, modifier_values = _values(candidate)
    primary = {key: _literal_positions(text, value) for key, value in primary_values.items()}
    modifiers = [_literal_positions(text, value) for value in modifier_values]
    if anchor is None:
        scored = [(score, i) for i, span in enumerate(segments) if (score := _score(primary, modifiers, span))]
        if not scored:
            # Source mentions and a scoped continuation can occupy adjacent sentences.
            for i, ((start, end), (next_start, next_end)) in enumerate(zip(segments, segments[1:])):
                if not (_LINK_CUE.search(text[next_start:next_end]) or _SCOPE_CUE.search(text[start:end])):
                    continue
                if score := _score(primary, modifiers, (start, next_end)):
                    scored.append((score, i))
            width = 2
        else:
            width = 1
        if scored:
            best = max(score for score, _ in scored)
            winners = [i for score, i in scored if score == best]
            if len(winners) != 1:
                return "AMBIGUOUS_ANCHOR", ()
            start = winners[0]
            end = start + width
            method = "LITERAL_CONTEXT_MATCH"
        else:
            method, start = _term_focus(text, segments, primary_values, modifier_values)
            if start is None:
                return method, ()
            end = start + 1
    else:
        matching = [i for i, (a, b) in enumerate(segments) if a < anchor[1] and anchor[0] < b]
        if not matching:
            return "NO_SOURCE_SEGMENT", ()
        start, end = matching[0], matching[-1] + 1

    focus_start, focus_end = segments[start][0], segments[end - 1][1]
    selected = list(range(start, end))
    for i in (start - 1, end):
        if 0 <= i < len(segments):
            left, right = segments[i]
            neighbor = text[left:right]
            modifier_outside_focus = any(
                any(left <= a < b <= right for a, b in positions)
                and not any(focus_start <= a < b <= focus_end for a, b in positions)
                for positions in modifiers)
            named = any(left <= a < b <= right for key, positions in primary.items() if key != "property"
                        for a, b in positions)
            if modifier_outside_focus or (_SCOPE_CUE.search(neighbor) and (named or _LINK_CUE.search(neighbor))):
                selected.append(i)
    return method, tuple(segments[i] for i in sorted(selected))
