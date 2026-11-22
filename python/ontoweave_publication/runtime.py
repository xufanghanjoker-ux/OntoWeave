"""Operator-supplied configuration for saved-source publication."""
import json
import os
import re
import shutil
import stat
from hashlib import sha256
from pathlib import Path

from ontoweave_ontology.material_context import MATERIAL_CONTEXT_VERSION
from ontoweave_ontology.native import NativeRuntime
from ontoweave_front_half.tool_execution import CONTINUE_KNOWN_FAILURE, FAILURE_POLICIES

from .store import require

REAL_ENDPOINT = "https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/responses"
RUNTIME_MODES = {"OFF", "NATIVE_SIM", "REAL"}
ROOT = Path(__file__).resolve().parents[2]
MATERIAL_FILES = frozenset({
    "python/ontoweave_ontology/agent.py", "python/ontoweave_ontology/material_context.py",
    "python/ontoweave_ontology/native.py", "python/ontoweave_ontology/native.mjs",
    "python/ontoweave_ontology/signatures.py", "python/ontoweave_ontology/service.py",
    "docs/skill-drafts/ontoweave-ontology-alignment-v1/SKILL.md",
    "web/native-agent-runtime-v1.mjs", "web/source-models-v1.mjs", "web/source-model-registry-v1.mjs",
    "web/native-agent-mcp-v1.mjs", "web/native-tool-outcomes-v1.mjs", "web/native-observable-progress-v1.mjs",
    "python/ontoweave_identity/native.py", "python/ontoweave_front_half/tool_execution.py",
    "python/ontoweave_ontology/recovery.py", "python/ontoweave_ontology/receiver.py",
})
GENERATION_KEYS = {"model", "reasoning_effort", "base_url", "endpoint_mode", "provider",
                   "profile_ref", "protocol", "timeout_ms"}


def isolated_pg(path):
    config = json.loads(Path(path).read_bytes())
    local = config.get("host")
    name = config.get("database")
    require(set(config) <= {"host", "port", "user", "database", "connect_timeout", "max"}
            and isinstance(local, str) and Path(local).is_absolute() and Path(local).is_dir()
            and isinstance(name, str) and (name.startswith("ontoweave_publication_")
                                          or name == "ontoweave_vector_query_validation")
            and name != "ontoweave_cq_acceptance", "ISOLATED_DB_REQUIRED", 422)
    require(isinstance(config.get("port"), int) and 1024 <= config["port"] <= 65535
            and bool(config.get("user")), "EXPLICIT_DB_REQUIRED", 422)
    return config


def verify_pg(q, settings):
    row = q("""SELECT current_database() AS db, current_user AS actor,
                inet_server_addr() IS NULL AS local_socket, current_setting('port')::int AS port""").fetchone()
    require(row["db"] == settings["database"] and row["port"] == settings["port"]
            and row["actor"] == settings["user"] and row["local_socket"], "ISOLATED_DB_MISMATCH", 422)


def _credential(name, path):
    if name:
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name), "CREDENTIAL_ENV_INVALID", 422)
        encoded = os.environ[name].encode() if name in os.environ else b""
    else:
        require(path, "CREDENTIAL_INPUT_REQUIRED", 422)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and not info.st_mode & 0o077, "CREDENTIAL_FILE_PERMISSIONS", 422)
            encoded = file.read(8193)
    require(0 < len(encoded) <= 8192, "CREDENTIAL_VALUE_INVALID", 422)
    value = encoded.decode().strip()
    require(value and all(not character.isspace() for character in value), "CREDENTIAL_VALUE_INVALID", 422)
    return value


def verify_material_binding(binding):
    """Pin the actual provider material producer and its Native transport."""
    require(isinstance(binding,dict) and set(binding)=={"lock_file","lock_sha256"},
            "PROVIDER_MATERIAL_BINDING_REQUIRED", 422)
    raw = Path(binding["lock_file"]).read_bytes()
    require(sha256(raw).hexdigest()==binding["lock_sha256"], "PROVIDER_MATERIAL_LOCK_CHANGED", 422)
    lock = json.loads(raw)
    require(lock.get("contract")=="ontoweave-provider-material-binding/1"
            and lock.get("version")==MATERIAL_CONTEXT_VERSION
            and set(lock.get("files", {}))==MATERIAL_FILES, "PROVIDER_MATERIAL_LOCK_INVALID", 422)
    require(all(sha256((ROOT/file).read_bytes()).hexdigest()==pin for file,pin in lock["files"].items()),
            "PROVIDER_MATERIAL_IMPLEMENTATION_CHANGED", 422)
    return {"version":lock["version"], "lock_sha256":binding["lock_sha256"]}


def native_generation(generation):
    """Translate the public Responses profile into the existing registry schema."""
    result = {key:generation[key] for key in ("model","base_url","timeout_ms") if key in generation}
    return dict(result, protocol="openai-compatible",
                endpoint_mode="full" if generation.get("endpoint_mode") == "responses" else "base")


def load_runtime(path, output, *, credential_env=None, credential_file=None, configuration_only=False):
    settings = json.loads(Path(path).read_bytes())
    mode = settings.get("mode")
    require(mode in RUNTIME_MODES and not (credential_env and credential_file), "RUNTIME_MODE_INVALID", 422)
    if mode == "OFF":
        require(set(settings) == {"mode"} and not (credential_env or credential_file), "OFF_CONFIGURATION_INVALID", 422)
        return mode, None, None
    require(not set(settings) - {"mode", "runtime_binding", "models", "concurrency", "simulation", "codex_executable", "material_binding", "execution_policy"},
            "RUNTIME_CONFIGURATION_INVALID", 422)
    generation = settings.get("models", {}).get("generation", {})
    concurrency = settings.get("concurrency", 1)
    policy = settings.get("execution_policy", CONTINUE_KNOWN_FAILURE)
    require(policy in FAILURE_POLICIES, "EXECUTION_POLICY_INVALID", 422)
    require(type(concurrency) is int and 1 <= concurrency <= 4 and set(settings["models"]) == {"generation"}
            and set(generation) <= GENERATION_KEYS and generation.get("model") == "qwen3.8-flash"
            and generation.get("reasoning_effort") == "low" and generation.get("protocol") == "responses",
            "GENERATION_CONFIGURATION_INVALID", 422)
    binding = settings.get("runtime_binding", {})
    require(set(binding) == {"lock_file", "lock_sha256"}, "NATIVE_RUNTIME_BINDING_INVALID", 422)
    lock = Path(binding["lock_file"]).resolve(strict=True)
    frozen = lock.read_bytes()
    require(sha256(frozen).hexdigest() == binding["lock_sha256"], "NATIVE_RUNTIME_LOCK_CHANGED", 422)
    executable = Path(settings.get("codex_executable") or os.environ.get("ONTOWEAVE_CODEX_EXECUTABLE")
                      or shutil.which("codex") or "").resolve(strict=True)
    require(executable.is_file() and os.access(executable, os.X_OK)
            and sha256(executable.read_bytes()).hexdigest() == json.loads(frozen)["executable_sha256"],
            "NATIVE_CODEX_EXECUTABLE_CHANGED", 422)
    material = None
    if mode=="REAL" or "material_binding" in settings:
        material = verify_material_binding(settings.get("material_binding"))
    if mode == "REAL":
        require("simulation" not in settings and generation.get("endpoint_mode") == "responses"
                and generation.get("base_url") == REAL_ENDPOINT, "REAL_PROVIDER_CONFIGURATION_INVALID", 422)
        credential = "" if configuration_only else _credential(credential_env, credential_file)
    else:
        require(not (credential_env or credential_file), "SIM_CREDENTIAL_FORBIDDEN", 422)
        credential = ""
    require(output, "NATIVE_EVIDENCE_DIRECTORY_REQUIRED", 422)
    os.environ["ONTOWEAVE_CODEX_EXECUTABLE"] = str(executable)
    provider = native_generation(generation)
    if configuration_only:
        return mode, None, dict(runtime_binding=dict(binding, lock_file=str(lock)), registry_generation=provider,
                                concurrency=concurrency)
    runtime = NativeRuntime(
        {"runtime_binding":dict(binding, lock_file=str(lock)), "models":{"generation":provider}},
        output, mode=mode, concurrency=concurrency, simulation=settings.get("simulation"), credential=credential, failure_policy=policy)
    public = dict(mode=mode, concurrency=concurrency, execution_policy=policy, generation=generation,
                  registry_generation=provider, runtime_lock_sha256=binding["lock_sha256"],
                  native_identity=runtime.identity, material_binding=material)
    return mode, runtime, public
