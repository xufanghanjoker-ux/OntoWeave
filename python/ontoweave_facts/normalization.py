"""Construct semantic keys and retain all statement-level provenance."""

from decimal import Decimal, InvalidOperation
from fractions import Fraction

from . import digest, ref
from .input import SEMANTIC_FIELDS


class OpenStatement(ValueError):
    pass


def _key_order(values):
    return sorted(values, key=digest)


def normalize_value(value, definition, value_type):
    if not isinstance(value, dict):
        raise OpenStatement("VALUE_UNINTERPRETED")
    if value.get("kind") == "ENTITY":
        if not value.get("entity_ref"):
            raise OpenStatement("IDENTITY_UNRESOLVED")
        return dict(kind="ENTITY", entity_ref=value["entity_ref"])
    if value.get("kind") != "VALUE" or value.get("value") is None:
        raise OpenStatement("VALUE_UNINTERPRETED")
    original, unit = value["value"], value.get("unit")
    if value_type != "DECIMAL":
        if not isinstance(original, (str, bool, int)):
            raise OpenStatement("VALUE_TYPE_UNINTERPRETED")
        return dict(kind="VALUE", value=original, unit=unit)
    try:
        number = Decimal(str(original))
        if not number.is_finite() or abs(number.adjusted()) > 1000:
            raise ValueError
        number = Fraction(number)
        conversions = definition.get("unit_conversions", {})
        # A definition may declare exact rational conversion from an explicit unit.
        if unit and unit in conversions:
            conversion = conversions[unit]
            number *= Fraction(conversion["factor"])
            unit = conversion["canonical_unit"]
    except (InvalidOperation, ValueError, ZeroDivisionError):
        raise OpenStatement("NUMERIC_VALUE_UNINTERPRETED") from None
    return dict(kind="DECIMAL", numerator=str(number.numerator), denominator=str(number.denominator), unit=unit)


def _qualifiers(statement, binding):
    roles = {role["source_role_key"]: role for role in binding.get("qualifier_roles", [])}
    groups = {role: [] for role in ("SCOPE", "ATTRIBUTION", "MODALITY", "CONTEXT")}
    opaque = []
    for position, qualifier in enumerate(statement.get("qualifiers", [])):
        if not isinstance(qualifier, dict) or not isinstance(qualifier.get("role_key"), str) or not qualifier["role_key"].strip():
            raise OpenStatement("QUALIFIER_UNINTERPRETED")
        role = roles.get(qualifier["role_key"], {})
        semantic = role.get("semantic_role")
        value = qualifier.get("value")
        if semantic in {None, "UNKNOWN"}:
            raw = qualifier.get("raw", qualifier)
            if not isinstance(raw, dict) or raw.get("value") is None:
                raise OpenStatement("QUALIFIER_UNINTERPRETED")
            opaque.append(dict(role_key=qualifier["role_key"], raw=raw, value=value,
                               position=qualifier.get("position", position),
                               occurrence_ref=qualifier.get("occurrence_ref")))
        elif semantic in groups and value is not None:
            key = role.get("role_definition_ref") or qualifier["role_key"]
            groups[semantic].append([key, value])
        else:
            raise OpenStatement("QUALIFIER_UNINTERPRETED")
    return {key: _key_order(values) for key, values in groups.items()}, opaque


def _group_policy(definition, scope, constraints, requested, *, opaque=False):
    applicable = []
    for constraint_ref in definition.get("constraint_refs", []):
        if opaque or constraint_ref not in requested:
            continue
        constraint = constraints[constraint_ref]
        if (constraint.get("status") == "ADOPTED" and constraint.get("basis_ref")
                and constraint.get("kind") in {"SINGLE_VALUE", "INVERSE_UNIQUE", "MUTUALLY_EXCLUSIVE"}
                and (constraint.get("scope") == scope or constraint.get("scope") == "ALL")):
            applicable.append(constraint)
    policy = dict(
        unique_subject=any(item["kind"] == "SINGLE_VALUE" for item in applicable),
        unique_object=any(item["kind"] == "INVERSE_UNIQUE" for item in applicable),
        exclusive_values=[item["values"] for item in applicable if item["kind"] == "MUTUALLY_EXCLUSIVE"],
    )
    return _key_order(applicable), policy


def group_content(library, content, policy):
    if policy["unique_object"] and (policy["unique_subject"] or policy["exclusive_values"]):
        holder = None
    elif policy["unique_object"]:
        holder = content["value"]
    else:
        holder = content["subject_ref"]
    return ref("fact_group", ["scope/1", library, content["predicate"], holder, content["conditions"], content["modality"]])


def normalize_assertion(statement, definition, binding, request, constraints):
    if not statement.get("structure_usable", True):
        raise OpenStatement("STRUCTURE_UNINTERPRETED")
    subject = statement.get("subject_ref")
    if not subject:
        raise OpenStatement("IDENTITY_UNRESOLVED")
    value = normalize_value(statement.get("value"), definition, statement.get("value_type"))
    treatment = binding.get("object_treatment")
    if treatment != ("PRESERVE_ENTITY" if value["kind"] == "ENTITY" else "PRESERVE_VALUE"):
        raise OpenStatement("OBJECT_TREATMENT_UNINTERPRETED")
    if binding["direction"] == "REVERSE" and value["kind"] == "ENTITY":
        subject, value = value["entity_ref"], dict(kind="ENTITY", entity_ref=subject)
    elif binding["direction"] != "FORWARD":
        raise OpenStatement("DIRECTION_UNINTERPRETED")
    qualifiers, opaque = _qualifiers(statement, binding)
    modality = statement.get("modality", "ASSERTED")
    if not isinstance(modality, str) or not modality:
        raise OpenStatement("MODALITY_UNINTERPRETED")
    if qualifiers["MODALITY"] and "modality" not in statement:
        raise OpenStatement("MODALITY_UNINTERPRETED")
    attribution = qualifiers["ATTRIBUTION"]
    if statement.get("attribution"):
        attribution = _key_order([*attribution, ["asserted_by", statement["attribution"]]])
    scope = qualifiers["SCOPE"]
    adopted, policy = _group_policy(definition, scope, constraints, set(request.get("constraint_refs", [])),
                                    opaque=bool(opaque))
    conditions = dict(scope=scope, scope_revision="scope/1", context=qualifiers["CONTEXT"],
                      attribution=attribution, modality_qualifiers=qualifiers["MODALITY"],
                      event_ref=statement.get("event_ref"), time_scope_ref=statement.get("time_scope_ref"))
    if opaque:
        # Equal raw words do not establish equal scope. A statement-local
        # group still allows deterministic replay of that statement.
        conditions.update(opaque_qualifiers=opaque, opaque_qualifier_statement_ref=statement["statement_ref"])
    content = dict(subject_ref=subject, predicate=definition["definition_key"], value=value,
                   conditions=conditions, negated=statement.get("negated", False), modality=modality)
    if not isinstance(content["negated"], bool):
        raise OpenStatement("POLARITY_UNINTERPRETED")
    world = statement.get("world_time")
    if world is None and statement.get("raw_times"):
        raise OpenStatement("TIME_UNINTERPRETED")
    if world is None:
        world = dict(kind="UNKNOWN", raw=None, basis=None)
    if not isinstance(world, dict) or world.get("kind") not in {"STATE", "EVENT", "WINDOW", "TIMELESS", "UNKNOWN"}:
        raise OpenStatement("TIME_UNINTERPRETED")
    if ((world["kind"] == "EVENT" or statement.get("statement_kind") in {"EVENT", "ACTION", "RULE"})
            and not conditions["event_ref"]):
        conditions["unresolved_occurrence_ref"] = statement["statement_ref"]
    supports = []
    for source in sorted(statement.get("source_refs", []), key=digest):
        source_id = ref("fact_evidence", [statement["statement_ref"], source])
        rust_source = dict(statement.get("previous_sources", {}).get(
            source_id, dict(source_version_id=source_id, kind="DOCUMENT", role="SUPPORT")))
        supports.append(dict(statement_ref=statement["statement_ref"], source=source, rust_source=rust_source,
                             original=statement.get("original", statement), qualifiers=statement.get("qualifiers", []),
                             world_time=world,
                             timezone_hints=statement.get("retained_timezone_hints", statement.get("timezone_hints", [])),
                             annotations={key: statement[key] for key in SEMANTIC_FIELDS if key in statement}))
    if not supports:
        raise OpenStatement("SOURCE_UNAVAILABLE")
    group = group_content(request["library_ref"], content, policy)
    return dict(
        policy_candidates=[constraints[key] for key in definition.get("constraint_refs", [])
                           if key in set(request.get("constraint_refs", []))],
        assertion=dict(content=content, valid_time=world, state_group=dict(key=group, single_valued=policy["unique_subject"]),
                       sources=list({row["rust_source"]["source_version_id"]: row["rust_source"] for row in supports}.values())),
        supports=supports, definition=definition, binding=binding, adopted_constraints=adopted, policy=policy,
        statement=statement, warnings=["QUALIFIER_ROLE_UNCLASSIFIED"] if opaque else [],
    )


def assertion_key(assertion, statement):
    world = assertion["valid_time"]
    event = world["kind"] == "EVENT" or statement.get("statement_kind") in {"EVENT", "ACTION", "RULE"}
    scoped_only = (event and not statement.get("event_ref")) or (
        world["kind"] == "UNKNOWN" and (event or not statement.get("time_scope_ref")))
    if world["kind"] == "STATE" and world.get("start") is None:
        scoped_only = True
    if world["kind"] != "TIMELESS":
        points = [world.get("start"), world.get("occurred_at")]
        end = world.get("end")
        points.append(end.get("point") if end and end.get("kind") == "EXACT" else end)
        scoped_only = scoped_only or any(
            isinstance(point, dict) and ("precision" in point and (point["precision"] == "UNKNOWN" or not point.get("value")))
            for point in points)
    if scoped_only and not statement.get("statement_ref"):
        return None

    def time_key(value):
        if not isinstance(value, dict):
            return value
        return {key: time_key(item) for key, item in value.items() if key not in {"raw", "basis"}}

    return ref("assertion", ["assertion/1", assertion["content"], time_key(world),
                             statement["statement_ref"] if scoped_only else None])
