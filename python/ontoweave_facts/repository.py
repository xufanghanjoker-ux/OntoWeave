"""Fact ledgers and group snapshots inside the publisher's transaction."""

from copy import deepcopy
from pathlib import Path

from psycopg.types.json import Jsonb

from ontoweave_cq.store import sha

from . import DEPENDENCIES, digest, require, verify
from .routing import EMPTY_BASE, fold_plan

MIGRATION = Path(__file__).resolve().parents[2] / "migrations/009-fact-routing-v1.sql"
EMPTY_DIGEST = digest(None)


def migrate(store):
    raw = MIGRATION.read_bytes()
    migration_sha = sha(raw)
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtextextended('ontoweave-fact-routing-v1-migration', 0))")
        exists = q("SELECT to_regclass('fact_routing_v1.schema_version') AS present").fetchone()["present"]
        if exists:
            row = q("SELECT sha256 FROM fact_routing_v1.schema_version WHERE version=9").fetchone()
            require(row and row["sha256"] == migration_sha, "FACT_MIGRATION_CHANGED")
        else:
            q(raw.decode("utf-8"))
            q("INSERT INTO fact_routing_v1.schema_version VALUES (9,%s)", [migration_sha])
    return dict(version=9, sha256=migration_sha, reused=bool(exists))


def read_fact_bundle(q, library_ref, bundle_ref):
    row = q("SELECT payload FROM fact_routing_v1.bundles WHERE library_ref=%s AND bundle_ref=%s",
            [library_ref, bundle_ref]).fetchone()
    require(row, "FACT_BUNDLE_UNKNOWN")
    return verify(row["payload"])


def _group_rows(q, library, revisions, keys=None):
    if not revisions or keys == []:
        return []
    selector = " AND s.group_key=ANY(%s)" if keys is not None else ""
    params = [revisions, library] + ([keys] if keys is not None else [])
    cursor = q("""SELECT DISTINCT ON (s.group_key) s.group_key,s.body_sha,s.payload
                  FROM unnest(%s::text[]) WITH ORDINALITY AS r(revision, ordinal)
                  JOIN fact_routing_v1.group_snapshots s ON s.fact_revision=r.revision
                  WHERE s.library_ref=%s""" + selector + " ORDER BY s.group_key,r.ordinal", params)
    rows = []
    while page := cursor.fetchmany(256):
        for row in page:
            require(row["body_sha"] == digest(row["payload"]), "FACT_GROUP_SNAPSHOT_TAMPERED")
            rows.append(row)
    return rows


def _prior_groups(q, library, revisions, statement_refs):
    if not revisions or not statement_refs:
        return []
    rows = q("""WITH candidates AS (
                    SELECT DISTINCT group_key
                    FROM fact_routing_v1.support_records
                    WHERE library_ref=%s AND fact_revision=ANY(%s) AND statement_ref=ANY(%s)
                ), current_groups AS (
                    SELECT DISTINCT ON (s.group_key) s.group_key,s.fact_revision
                    FROM unnest(%s::text[]) WITH ORDINALITY AS r(revision, ordinal)
                    JOIN fact_routing_v1.group_snapshots s ON s.fact_revision=r.revision
                    JOIN candidates c ON c.group_key=s.group_key
                    WHERE s.library_ref=%s
                    ORDER BY s.group_key,r.ordinal
                )
                SELECT DISTINCT s.group_key
                FROM current_groups g
                JOIN fact_routing_v1.support_records s USING (group_key,fact_revision)
                WHERE s.library_ref=%s AND s.statement_ref=ANY(%s)""",
             [library, revisions, statement_refs, revisions, library, library, statement_refs]).fetchall()
    return [row["group_key"] for row in rows]


def read_fact_snapshot(q, library, history, head, group_keys=None, statement_refs=()):
    """Read only the ordered confirmed manifest ancestry passed by the publisher.

    The first history entry is the newest fact revision. Entries carry the
    publisher-confirmed activation time for the first adoption of that revision.
    """
    history_by_ref = {entry["fact_revision"]: entry for entry in history}
    revisions = list(history_by_ref)
    require(len(revisions) == len(history), "FACT_HISTORY_DUPLICATE_REVISION")
    keys = None if group_keys is None else sorted(set(group_keys) | set(_prior_groups(q, library, revisions, statement_refs)))
    base = {**deepcopy(EMPTY_BASE), "head": head, "assertions": {}, "reviews": [],
            "supports": [], "supports_by_fact": {}, "policies": {}, "group_digests": {key: EMPTY_DIGEST for key in keys or ()},
            "affected_group_keys": keys or []}

    def adopted(item):
        data = dict(item["data"])
        recorded = history_by_ref.get(item["born_revision"])
        require(recorded, "FACT_HISTORY_ACTIVATION_MISSING")
        data["system"] = dict(from_seq=recorded["activation_seq"], to_seq=None,
                              recorded_from=recorded["activated_at"], recorded_to=None)
        return data

    for row in _group_rows(q, library, revisions, keys):
        group, key = row["payload"], row["group_key"]
        base["group_digests"][key] = row["body_sha"]
        base["versions"].extend(adopted(entry) for entry in group["versions"])
        base["support_links"].extend(adopted(entry) for entry in group["links"])
        base["assertions"].update(group["assertions"])
        base["supports"].extend(support for rows in group["supports"].values() for support in rows)
        base["supports_by_fact"].update(group["supports"])
        base["reviews"].extend(group["reviews"])
        base["policies"][key] = group["policy"]
    return base


def _insert_versions(q, library, revision, plan):
    for version in plan["new_versions"]:
        q("""INSERT INTO fact_routing_v1.fact_versions
             (library_ref,fact_version_ref,fact_ref,group_key,fact_revision,payload) VALUES(%s,%s,%s,%s,%s,%s)""",
          [library, version["fact_version_id"], version["fact_id"], version["state_group"]["key"], revision, Jsonb(version)])
    for closure in plan["close_versions"]:
        q("INSERT INTO fact_routing_v1.fact_closures VALUES(%s,%s,%s,%s)",
          [library, revision, closure["fact_version_id"], Jsonb(closure)])


def apply_fact_bundle(q, context, bundle):
    """Persist a certified immutable bundle and receipt using caller's live q."""
    verify(bundle)
    request = bundle["request"]
    library, revision = context["library_ref"], context["target_fact_revision"]
    require(request["library_ref"] == library and revision and all(
        key in context and context[key] == request[key] for key in DEPENDENCIES), "FACT_BUNDLE_DEPENDENCY_STALE")
    existing = q("SELECT payload,bundle_ref FROM fact_routing_v1.receipts WHERE library_ref=%s AND fact_revision=%s",
                 [library, revision]).fetchone()
    if existing:
        require(existing["bundle_ref"] == bundle["bundle_ref"], "FACT_REVISION_IMMUTABLE_CONFLICT")
        return existing["payload"]
    prior = q("SELECT bundle_ref FROM fact_routing_v1.bundles WHERE library_ref=%s AND operation_ref=%s",
              [library, request["operation_ref"]]).fetchone()
    require(not prior, "FACT_OPERATION_IMMUTABLE_CONFLICT")
    keys = bundle["affected_group_keys"]
    require(keys == sorted(set(keys)), "FACT_GROUP_KEYS_INVALID")
    for key in keys:
        q("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", [digest([library, key])])
    previous = {row["group_key"]: row for row in _group_rows(q, library, context["base_fact_revisions"], keys)}
    for key in keys:
        actual = previous.get(key, {}).get("body_sha", EMPTY_DIGEST)
        require(bundle["base_group_digests"].get(key, EMPTY_DIGEST) == actual, "FACT_GROUP_STALE")

    rust = bundle["rust"]
    base = rust["input"]["prepare"]["base"]
    plan = rust["output"]["plan"]
    require(plan["library_id"] == library and plan["request_id"] == request["operation_ref"]
            and plan["base_head"] == base["head"] and base["head"]["activation_ref"] == context["base_view_revision"],
            "FACT_RUST_PLAN_SCOPE_MISMATCH")
    versions, links = fold_plan(base, plan)
    require(set(bundle["assertions"]) == set(versions)
            and {item["state_group"]["key"] for item in versions.values()} <= set(keys), "FACT_PLAN_GROUP_COVERAGE")
    persisted = {item["data"][identity]: item for row in previous.values()
                 for section, identity in (("versions", "fact_version_id"), ("links", "support_link_id"))
                 for item in row["payload"][section]}
    planned = {item[identity]: {key: value for key, value in item.items() if key != "system"}
               for section, identity in (("versions", "fact_version_id"), ("support_links", "support_link_id"))
               for item in base[section]}
    require(planned == {key: value["data"] for key, value in persisted.items()}, "FACT_PLAN_BASE_NOT_PERSISTED")
    born = {key: value["born_revision"] for key, value in persisted.items()}
    receipt = dict(bundle_ref=bundle["bundle_ref"], body_sha=bundle["body_sha"], fact_revision=revision,
                   statement_results=bundle["result"]["statement_results"], counts=bundle["result"]["counts"])
    q("INSERT INTO fact_routing_v1.bundles VALUES(%s,%s,%s,%s,%s)",
      [library, bundle["bundle_ref"], request["operation_ref"], bundle["body_sha"], Jsonb(bundle)])
    q("INSERT INTO fact_routing_v1.receipts VALUES(%s,%s,%s,%s)", [library, revision, bundle["bundle_ref"], Jsonb(receipt)])
    _insert_versions(q, library, revision, plan)

    def entry(item, identity):
        return dict(born_revision=born.get(item[identity], revision),
                    data={key: value for key, value in item.items() if key != "system"})

    for key in keys:
        facts = {fact_ref: value for fact_ref, value in versions.items() if value["state_group"]["key"] == key}
        version_ids = {value["fact_version_id"] for value in facts.values()}
        supports = {fact_ref: bundle["supports"][fact_ref] for fact_ref in facts}
        group = dict(
            versions=[entry(facts[fact_ref], "fact_version_id") for fact_ref in sorted(facts)],
            links=[entry(link, "support_link_id") for link in sorted(links, key=lambda row: row["support_link_id"])
                   if link["fact_version_id"] in version_ids],
            assertions={fact_ref: bundle["assertions"][fact_ref] for fact_ref in facts}, supports=supports,
            reviews=[row for row in bundle["reviews"] if key in row["impact"]["group_keys"]],
            policy=rust["input"]["groups"].get(key, {}),
        )
        q("INSERT INTO fact_routing_v1.group_snapshots VALUES(%s,%s,%s,%s,%s)",
          [library, revision, key, digest(group), Jsonb(group)])
        for fact_ref, rows in supports.items():
            for row in rows:
                if row.get("statement_ref"):
                    q("""INSERT INTO fact_routing_v1.support_records VALUES(%s,%s,%s,%s,%s,%s,%s)
                         ON CONFLICT DO NOTHING""",
                      [library, revision, row["statement_ref"], facts[fact_ref]["fact_version_id"], key,
                       row["rust_source"]["source_version_id"], Jsonb(row)])
    for row in bundle["result"]["statement_results"]:
        q("INSERT INTO fact_routing_v1.routing_records VALUES(%s,%s,%s,%s)",
          [library, revision, row["statement_ref"], Jsonb(row)])
    for row in bundle["reviews"]:
        q("INSERT INTO fact_routing_v1.review_basis VALUES(%s,%s,%s,%s,%s)",
          [library, row["review_ref"], row["basis_version"], revision, Jsonb(row)])
    return receipt
