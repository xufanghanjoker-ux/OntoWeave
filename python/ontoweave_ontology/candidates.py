"""Recall a compact, directional vocabulary without treating observations as constraints."""

from ontoweave_identity.input import _sequence, name_key

from .signatures import SIMPLIFIED

LIMIT = 10


def recall(signature, definitions):
    kind = signature["kind"]
    if kind not in ("TYPE", "RELATION", "ATTRIBUTE"):
        return [], False
    phrase = signature["members"][0]["surface"]
    key = name_key(phrase)
    words = set(_sequence(phrase))
    available = []
    for definition in definitions:
        if definition["kind"] != kind or definition["definition_status"] == "RETIRED":
            continue
        if definition.get("allowed_shape_keys") and signature["shape_key"] not in definition["allowed_shape_keys"]:
            continue
        directions = (["FORWARD", "REVERSE"] if kind == "RELATION" else
                      ["FORWARD"] if kind == "ATTRIBUTE" else [])
        if "allowed_directions" in definition:
            directions = [v for v in directions if v in definition["allowed_directions"]]
        if kind != "TYPE" and not directions:
            continue
        label = definition["label"]
        score = (name_key(label) == key, len(words.intersection(_sequence(label))))
        available.append((score, definition["definition_ref"], dict(definition=definition, directions=directions)))
    available.sort(key=lambda row: (-row[0][0], -row[0][1], row[1]))
    if len(available) > LIMIT:
        lexical = [row for row in available if row[0][1]]
        if signature.get("alignment_contract") != SIMPLIFIED and (
                not lexical or len(lexical) > LIMIT and lexical[LIMIT - 1][0] == lexical[LIMIT][0]):
            return [], True
        available = lexical
    return [row[2] for row in available[:LIMIT]], False
