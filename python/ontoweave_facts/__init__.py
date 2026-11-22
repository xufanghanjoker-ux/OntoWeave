"""Prepare immutable fact changes for the shared OntoWeave publisher."""

from ontoweave_cq.store import require
from ontoweave_cq_similarity.core import digest

RULE_VERSION = "ontoweave-fact-routing-rust/1"
INPUT = "ontoweave-fact-routing-input/1"
RESULT = "ontoweave-fact-routing-result/1"
BUNDLE = "ontoweave-fact-bundle/1"
DEPENDENCIES = (
    "base_view_revision", "identity_revision", "ontology_alignment_ref",
    "time_revision", "source_manifest_ref",
)


def ref(prefix, value):
    return f"{prefix}_{digest(value)}"


def seal(bundle):
    body = {key: value for key, value in bundle.items() if key not in {"bundle_ref", "body_sha"}}
    body["result"] = {key: value for key, value in body["result"].items() if key != "bundle_ref"}
    sha = digest(body)
    bundle_ref = f"fact_bundle_{sha}"
    return {**body, "bundle_ref": bundle_ref, "body_sha": sha,
            "result": {**body["result"], "bundle_ref": bundle_ref}}


def verify(bundle):
    sealed = seal(bundle)
    require(bundle == sealed and bundle["contract"] == BUNDLE and bundle["rule_version"] == RULE_VERSION,
            "FACT_BUNDLE_INVALID")
    return bundle
