"""Build and stage three-domain decision plans through one public workflow."""
from ontoweave_facts.local import prepare_local_input
from ontoweave_facts.routing import prepare_routing
from ontoweave_identity.compound_decisions import overlay_identity, prepare_compound_decision
from ontoweave_identity.publication import stage_compound_identity
from ontoweave_ontology.source import load_identity

from .integration import confirmed_history, FactDecisionPlanner, prepare_publication, routing_request
from .store import assert_base, digest, head, manifest, projection, ref, require

DOMAINS = frozenset({"FACT","IDENTITY","ONTOLOGY"})


def _assert_domain_basis(plan, current, review_ref):
    require(plan.get("base_view_revision") == current["view_revision"] and
            plan.get("library_ref") == current["library_ref"] and
            plan.get("review_ref") == review_ref, "DOMAIN_PLAN_BASIS_MISMATCH")


class DecisionPlanner:
    def __init__(self, store, engine, *, enabled=DOMAINS):
        self.store = store
        self.engine = engine
        require(set(enabled) <= DOMAINS, "REVIEW_DOMAIN_REGISTRY_INVALID", 422)
        self.enabled = frozenset(enabled)
        self.facts = FactDecisionPlanner(store, engine)

    def __call__(self, library, adopted, review, request, *, actor, revert):
        domain = (review["request"].get("target_kind") if revert else review["target_kind"])
        require(domain in self.enabled, "DECISION_DOMAIN_UNAVAILABLE", 422)
        if domain == "FACT":
            return self.facts(library, adopted, review, request, actor=actor, revert=revert)
        require(not revert, "DOMAIN_REVERT_REQUIRES_EXPLICIT_CORRECTION", 422)
        from ontoweave_ontology import human

        view = adopted["view_revision"]
        operation = request["client_operation_ref"]
        decision = ref("decision", library, operation)
        local_operation = ref("domain_decision_plan", domain, library, view, operation)
        with self.store.transaction(readonly=True) as (q, _):
            assert_base(head(q, library), view)
            facts = list(projection(q, library, view, ("FACT",)).values())
        identity = load_identity(self.store, library, adopted["identity_revision"])
        change = None
        if domain == "IDENTITY":
            identity_plan = prepare_compound_decision(self.store, library, adopted, review, request, actor=actor)
            change = identity_plan["identity_change"]
            _assert_domain_basis(change, adopted, review["review_ref"])
            identity = overlay_identity(identity, change)
            ontology = human.plan_inheritance(
                self.store, adopted, identity["identity_revision"], change["affected_statement_refs"],
                operation_ref=local_operation, target_identity=identity, facts=facts)
            domain_plan = identity_plan
        else:
            ontology = human.plan_decision(self.store, adopted, review, request["intent"], decision_ref=decision,
                                           operation_ref=local_operation, actor_ref=actor, facts=facts)
            domain_plan = ontology

        target = ontology["result"]
        require(target["base_view_revision"] == view and target["library_ref"] == library
                and target["identity_revision"] == identity["identity_revision"], "DOMAIN_ONTOLOGY_BASIS_MISMATCH")
        statements = set(ontology["affected_statement_refs"])
        old_groups = set(ontology.get("affected_group_refs", []))
        if change:
            statements.update(change["affected_statement_refs"])
            old_groups.update(change["prior_group_keys"])
        routed = ontology["routing_bundle"]
        request_for_facts = routing_request(library, local_operation, adopted, identity["identity_revision"],
            target["target_ontology_revision"], adopted["time_revision"], adopted["source_manifest_ref"],
            statements, {"kind":"HUMAN_DECISION","refs":[decision]})
        request_for_facts["constraint_refs"] = [row["constraint_ref"] for row in routed.get("adopted_constraints",[])]
        with self.store.transaction(readonly=True) as (q, _):
            assert_base(head(q, library), view)
            history = confirmed_history(q, library, view)
            prepared = prepare_local_input(q, request_for_facts, adopted, history, identity, routed,
                                           ontology["snapshot"], old_group_keys=old_groups)
        bundle = prepare_routing(prepared["request"], prepared["ontology_bundle"], prepared["statements"],
                                 prepared["base"], self.engine)
        plan = prepare_publication(self.store, bundle, resolved_review=dict(review, decision_ref=decision),
                                   identity_snapshot=identity, ontology_plan=ontology, identity_change=change)
        domains = dict(ontology=ontology, identity=change)
        plan["publication"]["domain_plan_sha"] = digest(domains)
        graph_changes = plan.pop("diff")
        plan.update(domains=domains, before=domain_plan["before"], after=domain_plan["after"],
                    impact={**domain_plan["impact"], "affected_statement_refs": sorted(statements),
                            "affected_group_refs": bundle["affected_group_keys"], "graph":graph_changes,
                            "index":{key:len(rows) for key,rows in plan["index_delta"].items()}})
        return plan

    def feedback_review(self, adopted, request, facts):
        if "ONTOLOGY" not in self.enabled:
            return None
        from ontoweave_ontology.human import build_review
        return build_review(self.store, adopted, request, facts=facts)


def stage_domains(q, context, domains, bundle):
    """Stage both domain outcomes inside the same q as the facts and the step receipt."""
    from ontoweave_ontology.human import stage_plan

    identity, ontology = domains["identity"], domains["ontology"]
    library = context["library_ref"]
    adopted = manifest(q, library, context["base_view_revision"])
    target = ontology["result"]
    require(ontology["parent_ontology_revision"] == adopted["ontology_revision"]
            and target["base_view_revision"] == context["base_view_revision"]
            and target["identity_revision"] == context["identity_revision"]
            and target["target_ontology_revision"] == context["ontology_alignment_ref"],
            "DOMAIN_STAGE_BASIS_STALE")
    receipts = {}
    if identity:
        require(identity["library_ref"] == library
                and identity["base_identity_revision"] == adopted["identity_revision"]
                and identity["base_view_revision"] == context["base_view_revision"]
                and identity["target_identity_revision"] == context["identity_revision"], "DOMAIN_STAGE_BASIS_STALE")
        dispositions = {row["statement_ref"]:{"result":row["routing_result"],"rule_ref":row["rule_ref"]}
                        for row in bundle["result"]["statement_results"]}
        receipts["identity"] = stage_compound_identity(q, identity, dispositions)
    staged = stage_plan(q, ontology)
    require(staged["target_ontology_revision"] == context["ontology_alignment_ref"], "DOMAIN_STAGE_TARGET_CHANGED")
    receipts["ontology"] = {"ontology_revision":staged["target_ontology_revision"],
                            "plan_sha256":ontology["plan_sha256"]}
    return receipts
