"""Read persisted progress for a build assembled from settled PG artifacts."""
from psycopg.types.json import Jsonb
from ontoweave_cq_similarity.core import digest

from ontoweave_publication.readers import _publication_status
from ontoweave_publication.store import PublicationError, event, head, require


class BuildPort:
    def __init__(self, store):
        self.store = store

    def reserve(self, library, run, input_basis, *, recovery=None):
        with self.store.transaction() as (q, _):
            state = head(q, library, lock=True)
            require(state["active_view_revision"] is None and state["pending_view_revision"] is None,
                    "INITIAL_PUBLICATION_ALREADY_EXISTS")
            previous = q("""SELECT run_ref,body FROM publication_v1.builds
                            WHERE library_ref=%s AND body ? 'initial_input'""", [library]).fetchall()
            if recovery is None:
                require(not previous, "INITIAL_PUBLICATION_ALREADY_RESERVED")
            else:
                predecessor = recovery["predecessor_run_ref"]
                old = next((row["body"] for row in previous if row["run_ref"] == predecessor), None)
                require(recovery["contract"] == "ontoweave-ontology-recovery/1"
                        and recovery["library_ref"] == library and recovery["target_run_ref"] == run
                        and recovery["dispatch_eligible"]
                        and digest({k:v for k,v in recovery.items() if k!="plan_sha256"}) == recovery["plan_sha256"]
                        and old and all(row["body"]["execution_status"] == "FAILED" for row in previous)
                        and old["initial_input"]["source"] == input_basis["source"],
                        "INITIAL_RECOVERY_PREDECESSOR_NOT_ELIGIBLE")
                unsettled = q("""SELECT 1 FROM publication_v1.jobs WHERE library_ref=%s
                                 AND status IN ('QUEUED','RUNNING','UNKNOWN_HOLD') LIMIT 1""", [library]).fetchone()
                require(not unsettled, "INITIAL_RECOVERY_PUBLICATION_UNSETTLED")
                receipts = q("""SELECT receipt_key,payload,sha256 FROM ontology_v1.run_receipts
                                WHERE library_ref=%s AND run_ref=%s ORDER BY receipt_key""",
                             [library,predecessor]).fetchall()
                require(digest(receipts) == recovery["predecessor_receipts_sha256"],
                        "INITIAL_RECOVERY_PREDECESSOR_CHANGED")
                input_basis = {**input_basis, "recovery":dict(predecessor_run_ref=predecessor,
                                                             plan_sha256=recovery["plan_sha256"])}
            body = {"run_ref": run, "execution_status": "QUEUED", "stages": [],
                    "available_actions": [], "next_action": None, "initial_input": input_basis}
            row = q("""INSERT INTO publication_v1.builds VALUES(%s,%s,%s) ON CONFLICT DO NOTHING RETURNING run_ref""",
                    [library, run, Jsonb(body)]).fetchone()
            require(row, "BUILD_ALREADY_RESERVED")
            event(q, library, "build.stage_changed", {"stage":"RECEPTION","status":"QUEUED"}, run=run)

    def stage(self, library, run, stage, status, counts, *, execution_status="RUNNING", gaps=()):
        with self.store.transaction() as (q, _):
            head(q, library, lock=True)
            row = q("SELECT body FROM publication_v1.builds WHERE library_ref=%s AND run_ref=%s",
                    [library, run]).fetchone()
            result = row["body"] if row else {"run_ref":run,"stages":[],"available_actions":[],"next_action":None}
            existing = {item["stage"]:item for item in result["stages"]}
            now = q("SELECT clock_timestamp() AS stamp").fetchone()["stamp"].isoformat()
            entry = dict(existing.get(stage, {}), stage=stage, status=status, counts=counts, updated_at=now)
            if "started_at" not in entry:
                entry["started_at"] = now
            existing[stage] = entry
            result.update(execution_status=execution_status, stages=list(existing.values()), gaps=list(gaps))
            q("""INSERT INTO publication_v1.builds VALUES(%s,%s,%s)
                 ON CONFLICT(library_ref,run_ref) DO UPDATE SET body=EXCLUDED.body""", [library,run,Jsonb(result)])
            stopped = execution_status in {"FAILED","UNKNOWN_HOLD","CANCELLED"}
            event(q, library, "build.stopped" if stopped else "build.stage_changed",
                  dict(entry, execution_status=execution_status, gaps=list(gaps)), run=run)

    def read(self, library, run):
        with self.store.transaction(readonly=True) as (q, _):
            state = head(q, library)
            saved = q("SELECT body FROM publication_v1.builds WHERE library_ref=%s AND run_ref=%s",
                      [library, run]).fetchone()
            require(saved, "BUILD_NOT_FOUND", 404)
            target = q("""SELECT status,target_view_revision,job_ref,failure FROM publication_v1.jobs
                          WHERE library_ref=%s AND request->>'run_ref'=%s ORDER BY created_at DESC LIMIT 1""",
                       [library, run]).fetchone()
            body = {key:value for key,value in saved["body"].items() if key != "initial_input"}
            if target:
                body.update(publication_status=_publication_status(target["status"]),
                            view_revision=target["target_view_revision"] if target["status"]=="SUCCEEDED" else None,
                            failure=target["failure"], job_ref=target["job_ref"])
                if target["status"] == "SUCCEEDED":
                    for stage in body["stages"]:
                        if stage["stage"] == "PUBLICATION":
                            stage["status"] = "COMPLETED"
            else:
                body["publication_status"] = "NONE"
            return dict(body, active_view_revision=state["active_view_revision"])

    def receive(self, *_):
        raise PublicationError("PG_UPLOAD_INGRESS_UNAVAILABLE", 503)

    def resume_preview(self, *_):
        raise PublicationError("BUILD_RECOVERY_ADAPTER_UNAVAILABLE", 503)

    resume = resume_preview
    reconcile = resume_preview
