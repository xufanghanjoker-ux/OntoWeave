import copy
import json
import os
from pathlib import Path
from uuid import uuid4
import unittest

from psycopg.types.json import Jsonb
from ontoweave_cq.store import PGCQStore, sha
from ontoweave_identity.compound_decisions import (
    _reviews, _seal, identity_review_projection, overlay_identity, overlay_review_projection,
    plan_identity_change, prepare_compound_decision, verify_change_bundle,
)
from ontoweave_identity.matching import Groups
from ontoweave_identity.publication import activate_for_publisher, prepare_for_publisher, stage_job
from ontoweave_identity.service import _put_sources
from ontoweave_identity.storage import migrate as migrate_identity, create_revision, library_lock, update_bindings
from ontoweave_facts.repository import migrate as migrate_facts
from ontoweave_publication.coordinator import Publisher
from ontoweave_publication.store import PublicationError, manifest, migrate, projection


def fixture(library):
    occurrences, statements = {}, {}
    names = dict(a="Map archive", b="Cartography archive", c="Provincial museum", d="Civic station", e="Rail platform")
    alpha = dict(doc_ref="doc-a", revision="r1", chunk_ref="chunk-a", unit_ref="unit-a", precision="UNIT",
                 text="The Map archive is mentioned alongside the Provincial museum.")
    beta = dict(doc_ref="doc-b", revision="r2", chunk_ref="chunk-b", unit_ref="unit-b", precision="UNIT",
                text="The Cartography archive links the other preserved locations.")
    for source in (alpha, beta):
        source["text_sha256"] = sha(source["text"])

    def put(key, entity, role, source, statement=None):
        occurrences[key] = dict(occurrence_ref=key, home_entity_ref=entity, name_raw=names[entity],
                                role=role, alias_observations=[], type_observations=[], warnings=[],
                                identity_claims=[], origin={"item_ref":"item-"+key}, source_refs=[source],
                                statement_refs=[statement] if statement else [])
        return key

    def statement(key, source, subject, target, qualifier=None):
        endpoints = [dict(occurrence_ref=put(key+"-s",subject,"SUBJECT",source,key), role="SUBJECT",position=0),
                     dict(occurrence_ref=put(key+"-o",target,"OBJECT",source,key), role="OBJECT",position=0)]
        qualifiers = []
        if qualifier:
            endpoints.append(dict(occurrence_ref=put(key+"-q",qualifier,"QUALIFIER_ENTITY",source,key),
                                  role="QUALIFIER_ENTITY",position=0))
            qualifiers.append(dict(role_raw="context", value=names[qualifier],value_kind="限定实体"))
        candidate = dict(predicate="refers to", relation_phrase="refers to", subject=names[subject],
                         structure_usable=True, value_kind="客体", value_raw=names[target], unit=None,
                         qualifiers=qualifiers, times=[dict(value="2016")], extensions=[])
        statements[key] = dict(statement_ref=key, candidate_ref="candidate-"+key, candidate=candidate,
                               source_refs=[source], record=dict(raw_utf8=source["text"]),
                               origin={"item_ref":"item-"+key}, disposition="STRUCTURED",endpoints=endpoints)

    statement("base-side", alpha, "a", "c")
    statement("subject-move", beta, "b", "c")
    statement("object-move", beta, "c", "b")
    statement("qualifier-move", beta, "c", "d", "b")
    statement("unaffected", beta, "d", "e")
    homes = {k: row["home_entity_ref"] for k, row in occurrences.items()}
    review = dict(review_ref="identity-review-ab", left_ref="a", right_ref="b", stored_revision=1,
                  evidence_sha256="known-basis", status="PENDING", strategy="local",
                  reliable_same=[], direct_alias=[])
    snapshot = dict(library_ref=library, identity_revision="identity-1", sequence=1, homes=homes,
                    occurrences=occurrences, statements=statements, history=[], reviews=[review],
                    bindings={k:dict(occurrence_ref=k,entity_ref=v,decision_ref=None) for k,v in homes.items()})
    return snapshot


def request_for(view, review, kind):
    return dict(contract="ontoweave-decision-request/1", target_kind="IDENTITY", review_ref=review["review_ref"],
                base_view_revision=view["view_revision"], client_operation_ref="operation-"+kind,
                intent=dict(kind=kind, reason="Review of both source units"))


class IdentityContract(unittest.TestCase):
    def setUp(self):
        self.snapshot = fixture("contract")
        self.adopted = dict(view_revision="compound-1", identity_revision="identity-1")
        self.review, = _reviews(self.snapshot, Groups(set(self.snapshot["homes"].values()), [])).values()

    def plan(self, kind):
        return plan_identity_change(self.snapshot, self.adopted, self.review,
                                    request_for(self.adopted, self.review, kind), "TEST_ACTOR")

    def test_review_shape_and_three_role_redirect(self):
        self.assertEqual([a["kind"] for a in self.review["available_actions"]],
                         ["MERGE", "KEEP_SEPARATE", "DEFER"])
        self.assertEqual([len(s["statement_refs"]) for s in self.review["sides"]], [1, 3])
        self.assertTrue(all(s["evidence"] for s in self.review["sides"]))
        old = copy.deepcopy(self.snapshot)
        plan = self.plan("MERGE")
        bundle = _seal(plan["identity_change"])
        successor = overlay_identity(self.snapshot, bundle)
        self.assertEqual(old, self.snapshot)
        self.assertEqual(successor["statements"], old["statements"])
        self.assertEqual(bundle["entity_redirects"], [{"from":"b","to":"a"}])
        self.assertEqual(bundle["affected_statement_refs"], ["base-side","object-move","qualifier-move","subject-move"])
        self.assertEqual({r["role"] for rows in bundle["endpoint_changes"].values() for r in rows},
                         {"SUBJECT", "OBJECT", "QUALIFIER_ENTITY"})
        self.assertTrue(all(r["before_entity_ref"]=="b" and r["after_entity_ref"]=="a"
                            for rows in bundle["endpoint_changes"].values() for r in rows))
        self.assertIn("declared_constraint_collisions", plan["impact"]["unknown"])

    def test_shared_source_keeps_each_occurrence_and_technical_work_has_no_substantive_action(self):
        evidence = self.review["sides"][1]["evidence"]
        self.assertEqual(len({row["source_ref"] for row in evidence}), 1)
        self.assertEqual(len({row["statement_ref"] for row in evidence}), 3)
        self.assertEqual(len({row["occurrence_ref"] for row in evidence}), 3)
        self.assertTrue(all(row["precision"] == "UNIT" and row["statement_excerpt"]["raw_utf8"] for row in evidence))
        for row in evidence:
            if row["source_excerpt_range"]:
                interval = row["source_excerpt_range"]
                self.assertEqual(row["preview"], row["location"]["text"][interval["start"]:interval["end"]])
            else:
                self.assertIsNone(row["preview"])
        self.snapshot["reviews"][0].update(status="TECHNICAL_PENDING", adoption="IMPACT_INCOMPLETE",
                                          judgment=dict(judgment="SAME", reason="历史原稿"))
        review, = _reviews(self.snapshot, Groups(set(self.snapshot["homes"].values()), [])).values()
        self.assertEqual(review["model_suggestion"]["confidence_status"], "LEGACY_UNSCORED")
        self.assertEqual(review["model_suggestion"]["reason"], "历史原稿")
        self.assertIsNone(review["model_suggestion"]["confidence"])
        self.assertNotEqual(review["adoption"]["reason"], review["model_suggestion"]["reason"])
        self.assertFalse(review["review_eligibility"]["actionable"])
        self.assertEqual([a["kind"] for a in review["available_actions"]], ["DEFER"])

    def test_keep_separate_preserves_bindings_but_records_constraint(self):
        bundle = self.plan("KEEP_SEPARATE")["identity_change"]
        self.assertEqual(bundle["affected_statement_refs"], [])
        self.assertEqual(bundle["binding_updates"], {})
        self.assertEqual(bundle["identity_event"]["action"], "DIFFERENT")

    def test_rejects_stale_forged_evidence_and_disallowed_operations(self):
        request = request_for(self.adopted, self.review, "MERGE")
        for change, code in (
            (dict(base_view_revision="identity-internal-view"), "IDENTITY_COMPOUND_BASIS_STALE"),
            (dict(intent=dict(kind="MERGE", reason="fixture", evidence_refs=["other-source"])),
             "IDENTITY_DECISION_EVIDENCE_MISMATCH"),
            (dict(intent=dict(kind="RENAME", reason="fixture")), "IDENTITY_DECISION_INTENT_INVALID"),
        ):
            with self.subTest(change=change), self.assertRaisesRegex(PublicationError,code):
                plan_identity_change(self.snapshot,self.adopted,self.review,{**request,**change},"TEST_ACTOR")
        forged = dict(self.review, basis_sha256="forged")
        with self.assertRaisesRegex(PublicationError, "IDENTITY_REVIEW_BASIS_CHANGED"):
            plan_identity_change(self.snapshot,self.adopted,forged,request,"TEST_ACTOR")
        sealed = _seal(self.plan("MERGE")["identity_change"])
        with self.assertRaisesRegex(PublicationError, "IDENTITY_CHANGE_BUNDLE_INVALID"):
            verify_change_bundle(dict(sealed,target_identity_revision="changed"))

    def test_local_review_changes_leave_unrelated_reviews_byte_equal(self):
        extra = {**self.snapshot["reviews"][0],"review_ref":"unrelated","left_ref":"d","right_ref":"e"}
        redirect = {**self.snapshot["reviews"][0],"review_ref":"redirect","left_ref":"b","right_ref":"c"}
        self.snapshot["reviews"] += [extra, redirect]
        homes = set(self.snapshot["homes"].values())
        before = _reviews(self.snapshot, Groups(homes, []))
        plan = self.plan("MERGE")["identity_change"]
        event = dict(plan["identity_event"], stored_revision=2)
        after = _reviews(dict(self.snapshot,identity_revision=plan["target_identity_revision"]), Groups(homes,[event]))
        self.assertEqual(after["unrelated"], before["unrelated"])
        self.assertEqual(after["redirect"]["entity_refs"], ["a","c"])
        self.assertNotIn("identity-review-ab", after)

    def test_merge_cannot_override_existing_different(self):
        self.snapshot["history"] = [dict(action="DIFFERENT",left_ref="a",right_ref="b",
                                        decision_ref="earlier-different",stored_revision=1)]
        with self.assertRaisesRegex(PublicationError, "IDENTITY_REVIEW_BASIS_CHANGED"):
            self.plan("MERGE")


CONFIG = os.environ.get("COMPOUND_IDENTITY_TEST_PG")


@unittest.skipUnless(CONFIG, "explicit isolated PG fixture required")
class IdentityPG(unittest.TestCase):
    def setUp(self):
        self.settings=json.loads(Path(CONFIG).read_text())
        self.assertTrue(self.settings["database"].startswith("ontoweave_identity_compound_test_"))
        self.store=PGCQStore(self.settings)
        self.addCleanup(self.store.close)
        with self.store.transaction() as (q,_):
            self.assertEqual(q("SELECT current_database() AS database").fetchone()["database"], self.settings["database"])
        migrate_identity(self.store)
        migrate_facts(self.store)
        migrate(self.store)
        self.library="identity_compound_fixture_"+uuid4().hex

    def test_confirmed_manifest_basis_planner_and_publisher_scope(self):
        from ontoweave_publication import store as shared_store

        def fact_receipt(_q, context, bundle):
            return dict(bundle_ref=bundle["bundle_ref"], body_sha=bundle["body_sha"],
                        fact_revision=context["target_fact_revision"], statement_results=[])
        publisher=Publisher(self.store,fact_receipt,activate_identity=activate_for_publisher)
        publisher.register(self.library)
        fixture_data=fixture(self.library)
        origins, statements=fixture_data["occurrences"],fixture_data["statements"]
        homes=fixture_data["homes"]
        with self.store.transaction() as (q,_):
            locked=library_lock(q,self.library,publisher=True)
            version=create_revision(q,locked,"synthetic-contract")
            _put_sources(q,version,origins,statements)
            review=fixture_data["reviews"][0]
            q("INSERT INTO identity_v1.reviews VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
              [self.library,review["review_ref"],"a","b",review["evidence_sha256"],"local",
               version["revision"],Jsonb(review)])
            updates=update_bindings(q,self.library,version["revision"],homes,Groups(set(homes.values()),[]),{})
            job=stage_job(q,version,[],{},updates,origins,statements)
        self.assertIsNone(prepare_for_publisher(self.store,job["job_ref"],{
            key:{"result":"OPEN_UNINTERPRETED"} for key in statements}))
        identity_revision = version["identity_revision"]
        with self.store.transaction(readonly=True) as (q,_):
            reviews=identity_review_projection(q,self.library,identity_revision)
        row,=reviews.values()
        bundle=dict(bundle_ref="fixture-facts",body_sha="fixture")
        initial=dict(contract="ontoweave-publication-input/1", library_ref=self.library, request_ref="initial",
            trigger=dict(kind="INITIAL",refs=[]), base_view_revision=None, source_manifest_ref="fixture-source",
            fact_bundle_ref=bundle["bundle_ref"],fact_bundle_sha=bundle["body_sha"],coverage="FULL",gaps=[],
            target_revisions=dict(identity_revision=identity_revision,ontology_revision="ontology",
                                  time_revision="time",fact_revision="fact"), scope=dict(statement_refs=[]))
        job_ref=publisher.submit(initial)
        graph_delta={"REVIEW":reviews,"SOURCE":{e["source_ref"]:e["location"] for e in row["evidence"]}}
        sources=graph_delta["SOURCE"]
        adopted=publisher.apply(self.library,job_ref,bundle=bundle,graph_delta=graph_delta,
            index_delta={"SOURCE_LEXICAL":{k:{"object_ref":k,"text":s["text"]} for k,s in sources.items()}})
        self.assertNotEqual(adopted["view_revision"],version["view_revision"])
        request=request_for(adopted,row,"MERGE")
        reopened=PGCQStore(self.settings)
        try:
            change=prepare_compound_decision(reopened,self.library,adopted,row,request,actor="TEST_ACTOR")
            data=verify_change_bundle(change["identity_change"])
            with reopened.transaction(readonly=True) as (q,_):
                self.assertEqual(overlay_review_projection(q,self.library,data), {})
                self.assertEqual(manifest(q,self.library,adopted["view_revision"]),adopted)
                self.assertEqual(shared_store.head(q,self.library)["active_view_revision"],adopted["view_revision"])
                mirrors=q("SELECT active_revision,pending_revision FROM identity_v1.libraries WHERE library_ref=%s",
                          [self.library]).fetchone()
                self.assertEqual(mirrors,dict(active_revision=version["revision"],pending_revision=None))
                target=q("SELECT 1 FROM identity_v1.revisions WHERE identity_revision=%s",
                         [data["target_identity_revision"]]).fetchone()
                self.assertIsNone(target)
            with self.assertRaisesRegex(PublicationError,"VIEW_BASE_STALE"):
                prepare_compound_decision(reopened,self.library,adopted,row,
                    dict(request,base_view_revision=version["view_revision"]),actor="TEST_ACTOR")
            if os.environ.get("COMPOUND_IDENTITY_TEST_EVIDENCE"):
                path=Path(os.environ["COMPOUND_IDENTITY_TEST_EVIDENCE"])
                path.write_text(json.dumps(dict(confirmed_manifest=adopted,published_review=row,plan=change,
                    before_after_read_only=True,real_generation_calls=0),ensure_ascii=False,indent=2)+"\n")
        finally:
            reopened.close()


    @unittest.skipUnless(os.environ.get("COMPOUND_TEST_CORE"), "pinned Rust binary required")
    def test_formal_dispatcher_updates_facts_graph_index_with_one_head(self):
        from test_alignment import DraftRuntime

        from ontoweave_facts.repository import apply_fact_bundle
        from ontoweave_facts.routing import EMPTY_BASE, prepare_routing
        from ontoweave_facts.rust_adapter import RustEngine
        from ontoweave_ontology.repository import OntologyRepository
        from ontoweave_ontology.service import align
        from ontoweave_ontology.source import load_identity
        from ontoweave_publication.decisions import Decisions
        from ontoweave_publication.domains import DecisionPlanner, stage_domains
        from ontoweave_publication.integration import (
            confirmed_history, prepare_publication, read_routing_base, routing_request, routing_statements,
        )
        from ontoweave_publication.store import head as public_head

        core=Path(os.environ["COMPOUND_TEST_CORE"])
        self.assertEqual(sha(core.read_bytes()),os.environ["COMPOUND_TEST_CORE_SHA"])
        runtime=DraftRuntime()
        engine=RustEngine(core)
        repo=OntologyRepository(self.store)
        repo.migrate()
        publisher=Publisher(self.store,apply_fact_bundle,activate_identity=activate_for_publisher,stage_domains=stage_domains)
        decision_service=Decisions(self.store,DecisionPlanner(self.store,engine))
        evidence={}
        for action in ("MERGE","KEEP_SEPARATE"):
            library=self.library+"_"+action.lower()
            publisher.register(library)
            seed=fixture(library)
            homes, occurrences, statements=seed["homes"],seed["occurrences"],seed["statements"]
            with self.store.transaction() as (q,_):
                locked=library_lock(q,library,publisher=True)
                version=create_revision(q,locked,"formal-identity-fixture")
                _put_sources(q,version,occurrences,statements)
                queue=seed["reviews"][0]
                q("INSERT INTO identity_v1.reviews VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                    [library,queue["review_ref"],"a","b",queue["evidence_sha256"],"local",version["revision"],Jsonb(queue)])
                updates=update_bindings(q,library,version["revision"],homes,Groups(set(homes.values()),[]),{})
                mirror=stage_job(q,version,[],{},updates,occurrences,statements)
            identity=version["identity_revision"]
            aligned=align(self.store,dict(contract="ontoweave-ontology-alignment-input/1",library_ref=library,
                identity_revision=identity,run_ref=library+"_initial",base_view_revision=None,trigger={"kind":"INITIAL"}),runtime)
            ontology=aligned["target_ontology_revision"]
            routing=routing_request(library,library+"_routing",None,identity,ontology,"fixture-time","fixture-source",
                                    statements,{"kind":"INITIAL","refs":[]})
            inputs=routing_statements(load_identity(self.store,library,identity))
            for row in inputs.values():
                row["world_time"]={"kind":"STATE","start":{"value":"2026-01-01T00:00:00Z","precision":"EXACT"},
                                   "end":{"kind":"OPEN_AS_REPORTED"}}
            routed=prepare_routing(routing,repo.routing_bundle(library,ontology),inputs,EMPTY_BASE,engine)
            self.assertGreater(len(routed["assertions"]),0)
            dispositions={row["statement_ref"]:dict(result=row["routing_result"],rule_ref=row["rule_ref"])
                          for row in routed["result"]["statement_results"]}
            self.assertIsNone(prepare_for_publisher(self.store,mirror["job_ref"],dispositions))
            published=prepare_publication(self.store,routed)
            job=publisher.submit(published["publication"])
            first=publisher.apply(library,job,**{k:published[k] for k in ("bundle","graph_delta","index_delta","redirects")})
            first_view=first["view_revision"]
            with self.store.transaction(readonly=True) as (q,_):
                old=projection(q,library,first_view,("NODE","FACT","EDGE","REVIEW","ENTITY_NAME","FACT_LEXICAL","SOURCE"))
            card=old["REVIEW","identity-review-ab"]
            self.assertTrue(all(old["NODE", key]["pending"] for key in card["entity_refs"]))
            request=request_for(first,card,action)
            preview=decision_service.preview(library,"TEST_ACTOR",card["review_ref"],request)
            expected_merge=action=="MERGE"
            if expected_merge:
                self.assertEqual(set(preview["impact"]["affected_statement_refs"]),
                                 {"base-side","subject-move","object-move","qualifier-move"})
                self.assertTrue(preview["impact"]["affected_group_refs"])
            else:
                self.assertEqual(preview["impact"]["affected_statement_refs"],[])
            save_request=dict(request,preview_ref=preview["preview_ref"])
            saved,reused=decision_service.save(library,"TEST_ACTOR",card["review_ref"],save_request)
            self.assertFalse(reused)
            self.assertEqual(saved["decision_status"],"SAVED")
            with self.store.transaction(readonly=True) as (q,_):
                self.assertEqual(public_head(q,library)["active_view_revision"],first_view)
            successor=decision_service.process(publisher,library,saved["job_ref"])
            self.assertNotEqual(successor["view_revision"],first_view)
            fresh=PGCQStore(self.settings)
            try:
                with fresh.transaction(readonly=True) as (q,_):
                    now=projection(q,library,successor["view_revision"],("NODE","FACT","EDGE","REVIEW","ENTITY_NAME","FACT_LEXICAL","SOURCE"))
                    self.assertEqual(projection(q,library,first_view,("NODE","FACT","EDGE","REVIEW","ENTITY_NAME","FACT_LEXICAL","SOURCE")),old)
                    self.assertEqual(public_head(q,library)["active_view_revision"], successor["view_revision"])
                    latest=q("SELECT active_revision,pending_revision FROM identity_v1.libraries WHERE library_ref=%s",[library]).fetchone()
                    self.assertEqual(latest,dict(active_revision=version["revision"]+1,pending_revision=None))
                    fact_base=read_routing_base(q,library,confirmed_history(q,library,successor["view_revision"]),
                                                successor,None)
                mapping=load_identity(fresh,library,successor["identity_revision"])
                self.assertEqual(mapping["statements"],load_identity(fresh,library,identity)["statements"])
            finally:
                fresh.close()
            self.assertEqual(now["REVIEW","identity-review-ab"]["review_status"],"DECIDED")
            self.assertTrue(("ENTITY_NAME","a") in now and (("ENTITY_NAME","b") in now) != expected_merge)
            retained={}
            for support in fact_base["supports"]:
                key=support.get("statement_ref")
                if key in statements:
                    retained.setdefault(key,set()).add(support["source"]["text_sha256"])
            self.assertEqual(retained,{k:{row["text_sha256"] for row in statement["source_refs"]}
                                       for k,statement in statements.items()})
            if expected_merge:
                self.assertIn("Cartography archive",now["ENTITY_NAME","a"]["text"])
                self.assertIn("Map archive",now["ENTITY_NAME","a"]["text"])
                qualifier=next(v for k,v in now.items() if k[0]=="FACT" and "qualifier-move" in v["statement_refs"])
                def scalars(x):
                    if isinstance(x,dict):
                        return {value for nested in x.values() for value in scalars(nested)}
                    if isinstance(x,list):
                        return {value for nested in x for value in scalars(nested)}
                    return {x}
                self.assertIn("a",scalars(qualifier["content"]["conditions"]))
                self.assertNotIn("b",scalars(qualifier["content"]["conditions"]))
                for (kind,key), row in now.items():
                    if kind=="EDGE":
                        self.assertNotIn("b",(row["source"],row["target"]))
                    elif kind=="FACT":
                        self.assertNotEqual(row["content"]["subject_ref"],"b")
                        self.assertNotEqual(row["content"]["value"].get("entity_ref"),"b")
                        self.assertIn(("FACT_LEXICAL",key),now)
                self.assertFalse(any(binding["entity_ref"]=="b" for binding in mapping["bindings"].values()))
            else:
                self.assertEqual({k:v for k,v in now.items() if k[0]=="FACT"},{k:v for k,v in old.items() if k[0]=="FACT"})
            old_save,reused=decision_service.save(library,"TEST_ACTOR",card["review_ref"],save_request)
            self.assertTrue(reused)
            self.assertEqual(old_save["decision_status"],"APPLIED")
            with self.assertRaisesRegex(PublicationError,"VIEW_BASE_STALE"):
                decision_service.preview(library,"TEST_ACTOR",card["review_ref"],request)
            evidence[action]=dict(before=first,preview=preview,saved=saved,after=successor,
                fact_count_before=len([k for k in old if k[0]=="FACT"]), fact_count_after=len([k for k in now if k[0]=="FACT"]),
                edges_before=[v for k,v in old.items() if k[0]=="EDGE"],edges_after=[v for k,v in now.items() if k[0]=="EDGE"],
                entity_index_before=[v for k,v in old.items() if k[0]=="ENTITY_NAME"],
                entity_index_after=[v for k,v in now.items() if k[0]=="ENTITY_NAME"],
                unrelated_fact_preserved=(set(k for k,v in old.items() if k[0]=="FACT" and "unaffected" in v["statement_refs"])
                    <= set(k for k,v in now.items() if k[0]=="FACT" and "unaffected" in v["statement_refs"])),
                origin_statements_equal=True,history_unchanged=True,
                statement_support_shas={k:sorted(v) for k,v in retained.items()},
                fact_lexical_rows_before=[v for k,v in old.items() if k[0]=="FACT_LEXICAL"],
                fact_lexical_rows_after=[v for k,v in now.items() if k[0]=="FACT_LEXICAL"],
                real_generation_calls=0,real_embedding_calls=0)
        self.assertTrue(all(row["unrelated_fact_preserved"] for row in evidence.values()))
        if os.environ.get("COMPOUND_FORMAL_EVIDENCE"):
            Path(os.environ["COMPOUND_FORMAL_EVIDENCE"]).write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+"\n")
