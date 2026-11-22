"""One native Codex turn per batch, with the shared authenticated UTF-8 bridge."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from psycopg import InterfaceError, OperationalError

from ontoweave_cq.store import CQStoreError, require, sha
from ontoweave_extraction.planner import pins
from ontoweave_extraction.protocol import business_messages
from ontoweave_extraction.run import ExtractionRun
from ontoweave_front_half.native import NativeTransport
from ontoweave_front_half.records import PGRecords
from ontoweave_front_half.tool_execution import FixedMaterialRead
from .input import ref
from .storage import ROOT

SKILL = ROOT / "docs/skill-drafts/ontoweave-entity-resolution-v1/SKILL.md"
MODEL = "qwen3.8-flash"


class IdentityTurn(ExtractionRun):
    def reserve(self, *, agent_scope, request_bytes=0):
        with self.repo.transaction():
            reserved = super().reserve(agent_scope=agent_scope, request_bytes=request_bytes)
            state = self.state()
            state["attempts"][-1]["role"] = "IDENTITY"
            self.repo.put_record("extraction_runtime", self.run_id, state)
            return reserved


class IdentityTools:
    definitions = [dict(name="identity_read_material", description="候选材料已随输入提供。仅在需要重新核对时读取本批绑定材料。",
                        inputSchema=dict(type="object", properties={}, additionalProperties=False),
                        annotations=dict(readOnlyHint=True, destructiveHint=False,
                                         openWorldHint=False, idempotentHint=True))]

    def __init__(self, repo, run, batch):
        self.repo, self.run, self.batch = repo, run, batch
        self.final = None
        self.material_reader = FixedMaterialRead()

    def is_complete(self):
        return self.final is not None

    def call(self, name, args, context=None):
        if name == "identity_read_material":
            return self.material_reader.call(args, lambda: self.batch["prompt"])
        require(name == "__program_finalize_turn", "IDENTITY_TOOL_FORBIDDEN")
        native = args["native_completion"]
        refs = args["request_refs"]
        invocation = args["invocation_ref"]
        require(native["status"] == "completed" and bool(refs) and len(set(refs)) == len(refs), "IDENTITY_NATIVE_TURN_INVALID")
        events = (r["payload"] for r in self.repo.list_rows() if r["kind"] == "native_agent_event_v1"
                  and r["payload"].get("invocation_ref") == invocation)
        matched = False
        for event in events:
            notice = event.get("notification", {})
            params = notice.get("params", {})
            turn = params.get("turn", {})
            if (notice.get("method") == "turn/completed" and params.get("threadId") == native["thread_id"]
                    and turn.get("id") == native["turn_id"] and turn.get("status") == "completed"
                    and not turn.get("error")):
                matched = True
        attempts = self.run.state()["attempts"]
        require(matched and [(a["request_ref"], a["outcome"]) for a in attempts]
                == [(ref, "RETURNED") for ref in refs], "IDENTITY_NATIVE_TERMINAL_UNBOUND")
        final = None
        for ref in refs:
            wire = self.repo.get_record("native_agent_wire_v1", ref)
            response = self.repo.get_record("native_agent_response_v1", ref)
            require(wire and response and wire["agent_scope"] == self.batch["batch_ref"]
                    and wire["request_ref"] == response["request_ref"] == ref
                    and response["invocation_ref"] == wire["invocation_ref"] == invocation
                    and response.get("complete_body") and not response.get("redacted")
                    and not response.get("redaction_error") and sha(response["body_utf8"]) == response["body_sha256"],
                    "IDENTITY_NATIVE_RAW_UNAUTHENTICATED")
            messages = [m for m in business_messages(response["body_utf8"]) if m["text"].strip()]
            if ref == refs[-1] and messages:
                final = dict(messages=messages, request_ref=ref, native_completion=native,
                             transport_sha256=response["body_sha256"])
        if final is None:
            return dict(complete=False)
        self.repo.put_record("identity_business_output", self.batch["batch_ref"], final)
        self.final = final
        return dict(complete=True, saved_output=True)


class IdentityTransport(NativeTransport):
    def __init__(self, repo, run, config, credential, halt, *, continue_known=False):
        self.halt, self.continue_known = halt, continue_known
        self.database_unknown = False
        super().__init__(repo, run, config, credential)

    def call(self, scope, op, args):
        if op == "reserve":
            require(not self.halt.is_set(), "IDENTITY_DISPATCH_HALTED")
        try:
            result = super().call(scope, op, args)
        except (OperationalError, InterfaceError) as exc:
            self.database_unknown = True
            self.halt.set()
            raise CQStoreError("NATIVE_DATABASE_COMMIT_UNKNOWN") from exc
        if op == "settle" and args["outcome"] != "RETURNED" and not (
            self.continue_known and args["outcome"] == "FAILED"
            and args.get("reason") in ("NATIVE_UPSTREAM_HTTP_FAILED", "CQ_STREAM_FAILED")
        ):
            self.halt.set()
        return result

    async def invoke(self, request):
        self.active[request.agent_scope] = request
        payload = {k: getattr(request, k) for k in ("agent_scope", "prompt", "skill_paths", "model",
                                                    "runtime_directory", "mode", "simulation")}
        payload.update(rpc_url="http://127.0.0.1:" + str(self.server.server_port), rpc_token=self.token,
                       definitions=request.tools.definitions, generation=self.config["models"]["generation"],
                       runtime_binding=self.config["runtime_binding"], api_key=self.credential)
        proc = await asyncio.create_subprocess_exec(
            "node", str(ROOT / "python/ontoweave_identity/native.mjs"), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=ROOT,
        )
        stdout, stderr = await proc.communicate(json.dumps(payload).encode("utf-8"))
        self.repo.put_record("identity_native_process", request.agent_scope,
                             dict(exit_code=proc.returncode, stderr_bytes=len(stderr), mode=request.mode))
        result = json.loads(stdout)
        self.repo.put_record("identity_native_receipt", request.agent_scope, result)
        require(proc.returncode == 0, result.get("error", "IDENTITY_NATIVE_TRANSPORT_FAILED"))
        return result


class NativeRuntime:
    def __init__(self, config, output, *, mode="NATIVE_SIM", credential="", simulation=None, concurrency=4):
        upstream = pins_for_v3()
        generation = config["models"]["generation"]
        require(mode in ("REAL", "NATIVE_SIM") and generation["model"] == MODEL
                and generation.get("reasoning_effort", "low") == "low", "IDENTITY_NATIVE_CONFIG_INVALID")
        if mode == "REAL":
            require(credential and simulation is None, "IDENTITY_REAL_CONFIGURATION_INVALID")
        lock = config["runtime_binding"]
        require(sha(Path(lock["lock_file"]).read_bytes()) == lock["lock_sha256"], "IDENTITY_RUNTIME_LOCK_CHANGED")
        self.config, self.output = config, Path(output).resolve()
        self.mode, self.credential, self.concurrency = mode, credential, concurrency
        self.simulation = simulation or {}
        self.semantic_identity = dict(model=MODEL, reasoning_effort="low", mode=mode,
                                      skill_sha256=sha(SKILL.read_bytes()),
                                      model_config_ref=ref("identity_model_config", {
                                          k: v for k, v in generation.items()
                                          if k not in {"api_key", "credential", "password", "token"}
                                      }))
        self.identity = dict(model=MODEL, reasoning_effort="low", mode=mode, skill_sha256=sha(SKILL.read_bytes()),
                             runtime_lock_sha256=lock["lock_sha256"],
                             upstream_baseline=upstream["baseline"]["baseline_id"],
                             bridge_sha256=sha((ROOT / "web/native-agent-runtime-v1.mjs").read_bytes()),
                             adapter_sha256=sha(Path(__file__).with_suffix(".mjs").read_bytes()),
                             derivation_sha256=sha(Path(__file__).with_name("native-runtime.mjs").read_bytes()))

    def invoke(self, store, batch, halted):
        if halted.is_set():
            return dict(status="HELD_AFTER_TECHNICAL_FAILURE", generation_requests=0)
        scope = batch["batch_ref"]
        repo = PGRecords(store, "identity:v1:" + scope)
        repo.migrate()
        run = IdentityTurn(repo, repo.run_id)
        tools = IdentityTools(repo, run, batch)
        transport = IdentityTransport(repo, run, self.config, self.credential, halted)
        simulation = None
        if self.mode == "NATIVE_SIM":
            supplied = self.simulation.get(scope, self.simulation.get("default"))
            default = "\n\n".join(
                f"候选：{k}\n判断：无法判断\n置信度：0.5\n依据：离线演练，保留独立对象。" for k in batch["labels"])
            simulation = supplied if isinstance(supplied, list) else [supplied or dict(text=default)]
        request = SimpleNamespace(agent_scope=scope, prompt=batch["prompt"], skill_paths=[str(SKILL)], model=MODEL,
                                  runtime_directory=str(self.output / "runtime" / scope),
                                  mode=self.mode, simulation=simulation, tools=tools)
        error = None
        try:
            result = asyncio.run(transport.invoke(request))
        except Exception as exc:
            result, error = {}, getattr(exc, "code", None) or type(exc).__name__
        finally:
            transport.close()
        attempts = run.state()["attempts"]
        receipt = result.get("receipt", {})
        unknown = transport.database_unknown or receipt.get("status") == "UNKNOWN" or any(a["outcome"] in ("UNKNOWN", "RESERVED") for a in attempts)
        status = "UNKNOWN_HOLD" if unknown else "COMPLETED" if tools.final and result.get("complete") else "FAILED"
        if status in ("UNKNOWN_HOLD", "FAILED"):
            halted.set()
        return dict(status=status, error=error, receipt=receipt,
                    generation_requests=len(attempts) if self.mode == "REAL" else 0,
                    simulated_requests=len(attempts) if self.mode == "NATIVE_SIM" else 0,
                    usage=[a["usage"] for a in attempts if a.get("usage")],
                    messages=(tools.final or {}).get("messages", []),
                    runtime_run_ref=repo.run_id)


def pins_for_v3():
    from ontoweave_extraction import V3_POLICY_VERSION
    return pins(V3_POLICY_VERSION)
