"""Bind semantic judgments to evidence, independently of graph publication and adoption."""

from collections import defaultdict

from ontoweave_cq.store import require

from .input import ref

VERDICT_POLICY = "identity-semantic-verdict/3"
VALID_VERDICTS = {"SAME", "DIFFERENT", "UNKNOWN"}


def judgment_key(pair, runtime):
    semantic_runtime = getattr(runtime, "semantic_identity", runtime.identity)
    # The whole two-sided profile participates, including a source revision or
    # a fact which was not chosen as a representative for this prompt.
    return ref("identity_semantic_judgment",
               [VERDICT_POLICY, semantic_runtime, pair["left_ref"], pair["right_ref"], pair["left"], pair["right"]])


def read_verdicts(q, library, keys_to_pairs, *, continuation=False):
    """Return semantic results, blocked dispatches and archive references by pair."""
    if not keys_to_pairs:
        return {}, {}
    rows = q("""SELECT batch_ref,status,payload->'judgment_keys' AS keys,
                       payload->'labels' AS labels,payload->'judgments' AS judgments
                FROM identity_v1.batch_results WHERE library_ref=%s
                  AND (payload->'judgment_keys') ?| %s::text[]
                ORDER BY batch_ref""", [library, sorted(keys_to_pairs)]).fetchall()
    found = defaultdict(list)
    for row in rows:
        bound = {v["review_ref"]: v for v in row["labels"].values()}
        for key in row["keys"].keys() & keys_to_pairs.keys():
            archived_ref = row["keys"][key]
            answer = (row["judgments"] or {}).get(archived_ref, {})
            if answer.get("judgment") in VALID_VERDICTS:
                require(row["status"] in ("COMPLETED", "PARTIAL") and archived_ref in bound
                        and answer.get("evidence_sha256") == bound[archived_ref]["evidence_sha256"]
                        and answer.get("raw_sha256") and answer.get("message_id") is not None,
                        "IDENTITY_CACHED_JUDGMENT_INVALID")
            found[key].append((row["status"], row["batch_ref"], archived_ref, answer))
    cached, blocked = {}, {}
    for key, entries in found.items():
        pair = keys_to_pairs[key]
        review = pair["review_ref"]
        if any(status == "UNKNOWN_HOLD" for status, *_ in entries):
            blocked[review] = "UNKNOWN_HOLD"
            continue
        if any(status == "STARTED" for status, *_ in entries):
            blocked[review] = "INFLIGHT_JUDGMENT"
            continue
        settled = [(batch, origin, answer) for status, batch, origin, answer in entries
                   if status in ("COMPLETED", "PARTIAL") and answer.get("judgment") in VALID_VERDICTS]
        if settled:
            require(len(settled) == 1, "IDENTITY_CACHED_JUDGMENT_AMBIGUOUS")
            batch, origin, answer = settled[0]
            cached[review] = dict(answer, evidence_sha256=pair["evidence_sha256"],
                                  cached_from=dict(semantic_ref=key, batch_ref=batch, review_ref=origin,
                                                   evidence_sha256=answer["evidence_sha256"]))
        elif not continuation:
            blocked[review] = "FAILED" if any(s == "FAILED" for s, *_ in entries) else "KNOWN_JUDGMENT_GAP"
    return cached, blocked
