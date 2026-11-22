"""Native Codex app-server adapter with authenticated terminal capture."""

import asyncio
import json
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace

from ontoweave_cq.store import require, sha
from ontoweave_extraction.run import ExtractionRun
from ontoweave_front_half.baselines import verify_baseline
from ontoweave_front_half.records import PGRecords
from ontoweave_front_half.tool_execution import (CONTINUE_KNOWN_FAILURE, FAILURE_POLICIES,
                                                  STOP_ON_KNOWN_FAILURE, should_stop)
from ontoweave_identity.input import ref
from ontoweave_identity.native import IdentityTools, IdentityTransport

from .agent import DIRECT_PROMPT, PROMPT
from .signatures import SIMPLIFIED
from .repository import ROOT

SKILL = ROOT / "docs/skill-drafts/ontoweave-ontology-alignment-v1/SKILL.md"
DIRECT_SKILL = ROOT / "docs/skill-drafts/ontoweave-ontology-alignment-v2/SKILL.md"
MODEL = "qwen3.8-flash"


class OntologyTurn(ExtractionRun):
    def reserve(self, *, agent_scope, request_bytes=0):
        with self.repo.transaction():
            reserved = super().reserve(agent_scope=agent_scope, request_bytes=request_bytes)
            state = self.state()
            state["attempts"][-1]["role"] = "ONTOLOGY"
            self.repo.put_record("extraction_runtime", self.run_id, state)
            return reserved


class OntologyTools(IdentityTools):
    definitions = [dict(name="ontology_read_material", description="读取本批绑定的语义签名、代表材料与定义候选。",
                        inputSchema=dict(type="object", properties={}, additionalProperties=False),
                        annotations=dict(readOnlyHint=True, destructiveHint=False,
                                         openWorldHint=False, idempotentHint=True))]

    def call(self, name, args, context=None):
        if name == "ontology_read_material":
            return self.material_reader.call(args, lambda: json.loads(self.batch["material"]))
        require(name == "__program_finalize_turn", "ONTOLOGY_TOOL_FORBIDDEN")
        direct_prompt = self.batch.get("direct_prompt")
        if direct_prompt:
            if not args["request_refs"]:
                return dict(complete=False)
            wire = self.repo.get_record("native_agent_wire_v1", args["request_refs"][0])
            require(wire and sha(wire["body_utf8"]) == wire["body_sha256"],
                    "ONTOLOGY_FIRST_MATERIAL_WIRE_UNAUTHENTICATED")
            body = json.loads(wire["body_utf8"])
            require(any(direct_prompt in part.get("text", "")
                        for item in body["input"] if item.get("role") == "user"
                        for part in item.get("content", [])), "ONTOLOGY_FIRST_MATERIAL_NOT_DELIVERED")
        elif not self.material_reader.delivered:
            return dict(complete=False)
        return super().call(name, args, context)


class OntologyTransport(IdentityTransport):
    async def invoke(self, request):
        started = perf_counter()
        self.active[request.agent_scope] = request
        payload = {k: getattr(request, k) for k in ("agent_scope", "prompt", "skill_paths", "model",
                                                    "runtime_directory", "mode", "simulation")}
        payload.update(rpc_url="http://127.0.0.1:" + str(self.server.server_port), rpc_token=self.token,
                       definitions=request.tools.definitions, generation=self.config["models"]["generation"],
                       runtime_binding=self.config["runtime_binding"], api_key=self.credential)
        proc = await asyncio.create_subprocess_exec(
            "node", str(Path(__file__).with_suffix(".mjs")), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=ROOT,
        )
        spawned = perf_counter()
        stdout, stderr = await proc.communicate(json.dumps(payload).encode())
        self.repo.put_record("ontology_native_process", request.agent_scope,
                             dict(exit_code=proc.returncode, stderr_bytes=len(stderr), mode=request.mode,
                                  spawn_ms=(spawned-started)*1000, process_wall_ms=(perf_counter()-started)*1000))
        result = json.loads(stdout)
        self.repo.put_record("ontology_native_receipt", request.agent_scope, result)
        require(proc.returncode == 0, result.get("error", "ONTOLOGY_NATIVE_TRANSPORT_FAILED"))
        return result


class NativeRuntime:
    def __init__(self, config, output, *, simulation=None, concurrency=4, mode="NATIVE_SIM",
                 credential="", failure_policy=STOP_ON_KNOWN_FAILURE, alignment_contract=SIMPLIFIED):
        generation = config["models"]["generation"]
        require(mode in ("NATIVE_SIM", "REAL") and generation["model"] == MODEL and
                generation.get("reasoning_effort", "low") == "low", "ONTOLOGY_NATIVE_CONFIG_INVALID")
        if mode == "REAL":
            require(credential and simulation is None, "ONTOLOGY_REAL_CONFIG_INVALID")
        require(failure_policy in FAILURE_POLICIES and type(concurrency) is int and 1 <= concurrency <= 4,
                "ONTOLOGY_EXECUTION_POLICY_INVALID")
        require(alignment_contract in (None, SIMPLIFIED), "ONTOLOGY_ALIGNMENT_CONTRACT_INVALID")
        self.skill = DIRECT_SKILL if alignment_contract == SIMPLIFIED else SKILL
        self.mode, self.credential, self.failure_policy = mode, credential, failure_policy
        baseline = verify_baseline()
        lock = config["runtime_binding"]
        require(sha(Path(lock["lock_file"]).read_bytes()) == lock["lock_sha256"], "ONTOLOGY_RUNTIME_LOCK_CHANGED")
        self.config, self.output = config, Path(output).resolve()
        self.concurrency, self.simulation = concurrency, simulation or {}
        self.identity = dict(model=MODEL, reasoning_effort="low", mode=mode, skill_sha256=sha(self.skill.read_bytes()),
                             runtime_lock_sha256=lock["lock_sha256"], upstream_baseline=baseline["baseline_id"],
                             bridge_sha256=sha((ROOT / "web/native-agent-runtime-v1.mjs").read_bytes()),
                             adapter_sha256=sha(Path(__file__).with_suffix(".mjs").read_bytes()),
                             host_adapter_sha256=sha(Path(__file__).read_bytes()))
        if alignment_contract == SIMPLIFIED:
            self.identity["alignment_contract"] = SIMPLIFIED

    def invoke(self, store, batch, halted):
        if halted.is_set():
            return dict(status="HELD_AFTER_TECHNICAL_FAILURE")
        scope = batch["batch_ref"]
        ledger = ref("ontology_native", [batch["run_ref"], scope])
        repo = PGRecords(store, ledger)
        repo.migrate()
        run = OntologyTurn(repo, ledger)
        direct = self.identity.get("alignment_contract") == SIMPLIFIED
        prompt = PROMPT
        if direct:
            require(batch["material_sha256"] == sha(batch["material"]), "ONTOLOGY_BATCH_MATERIAL_CHANGED")
            prompt = DIRECT_PROMPT + "\n\n" + batch["material"]
            batch = {**batch, "direct_prompt": prompt}
        tools = OntologyTools(repo, run, batch)
        transport = OntologyTransport(repo, run, self.config, self.credential, halted,
                                      continue_known=self.failure_policy == CONTINUE_KNOWN_FAILURE)
        simulation = None
        if self.mode == "NATIVE_SIM":
            supplied = self.simulation.get(scope, self.simulation.get("default"))
            default = "\n".join(json.dumps(dict(signature=k, action="OPEN", evidence=[], reason="离线模拟"),
                                           ensure_ascii=False) for k in batch["labels"]["signatures"])
            simulation = [{"text": default}] if direct else [
                {"read_material": True}, {"expect_tool_output": True, "text": default}]
            if isinstance(supplied, list):
                simulation = supplied
            elif supplied is not None and direct:
                simulation[0].update(supplied)
            elif supplied is not None:
                if "read_arguments" in supplied:
                    simulation[0]["read_arguments"] = supplied["read_arguments"]
                simulation[1].update({k: v for k, v in supplied.items() if k != "read_arguments"})
        request = SimpleNamespace(agent_scope=scope, prompt=prompt, skill_paths=[str(self.skill)], model=MODEL,
                                  runtime_directory=str(self.output / "runtime" / ledger),
                                  mode=self.mode, simulation=simulation, tools=tools)
        error = None
        started = perf_counter()
        try:
            result = asyncio.run(transport.invoke(request))
        except Exception as exc:
            result, error = {}, getattr(exc, "code", None) or type(exc).__name__
        finally:
            closing = perf_counter()
            transport.close()
        closed = perf_counter()
        attempts = run.state()["attempts"]
        receipt = result.get("receipt", {})
        unknown = transport.database_unknown or receipt.get("status") == "UNKNOWN" or any(a["outcome"] in ("UNKNOWN", "RESERVED") for a in attempts)
        status = "UNKNOWN_HOLD" if unknown else "COMPLETED" if tools.final and result.get("complete") else "FAILED"
        failure = ("UNKNOWN_HOLD" if unknown else
                   receipt.get("failure_class", "FATAL") if status == "FAILED" else None)
        if should_stop(dict(status=status, failure_class=failure), self.failure_policy):
            halted.set()
        timing = dict(node_and_native_ms=(closing-started)*1000, python_bridge_close_ms=(closed-closing)*1000,
                      rpc_turnaround_ms=sum(row['wall_ms'] for row in transport.timings),
                      tool_rpc_ms=sum(row['wall_ms'] for row in transport.timings if row['op']=='tool'),
                      pg_transaction_ms=sum(row.get('transaction_ms',0) for row in repo.metrics))
        return dict(status=status, failure_class=failure, error=error, receipt=receipt, timing_ms=timing,
                    generation_requests=len(attempts) if self.mode == "REAL" else 0,
                    simulated_requests=len(attempts) if self.mode == "NATIVE_SIM" else 0,
                    usage=[a["usage"] for a in attempts if a.get("usage")],
                    messages=(tools.final or {}).get("messages", []), raw_final=tools.final,
                    runtime_run_ref=repo.run_id)
