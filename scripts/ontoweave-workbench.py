#!/usr/bin/env python3
"""Prepare and run the paired local PostgreSQL workbench services."""
import argparse
from contextlib import ExitStack
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from secrets import token_urlsafe
import signal
import socket
import stat
import subprocess
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import monotonic, sleep
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

import psycopg

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".ontoweave"
PINS = ROOT / "contracts/workbench-runtime-v1"
SOURCE_MANIFEST_SHA256 = "057b933f96c70315976bdad9e4b11eb8ee6986a4298fc91da8465dd41d07b20c"
MATERIAL_SHA256 = "8307c47f7d20dc321f5bec14f67c1d774bfa3a0aa09ab032111864ec71adcc91"
TOKENIZER_SHA256 = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"
GENERATION = {
    "model": "qwen3.8-flash", "reasoning_effort": "low",
    "base_url": "https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/responses",
}
CREDENTIAL_ENV = "ONTOWEAVE_WORKBENCH_EMBEDDING_CREDENTIAL_FILE"

sys.path.insert(0, str(ROOT / "python"))
from ontoweave_front_half.baselines import verify_baseline
from ontoweave_product.runtime import REAL_EMBEDDING, SIM_EMBEDDING
from ontoweave_publication.runtime import isolated_pg, load_runtime


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(file):
    return sha256(file.read_bytes()).hexdigest()


def read(file):
    return json.loads(file.read_bytes())


def write(file, data):
    with NamedTemporaryFile("w", dir=file.parent, delete=False) as stream:
        pending = Path(stream.name)
        try:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(pending, file)
        finally:
            pending.unlink(missing_ok=True)


def private_directory(path):
    path.mkdir(exist_ok=True, mode=0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            f"Use an owner-only directory with mode 0700: {path}")


def validate_port(port):
    return type(port) is int and 1024 <= port <= 65535


def settings(file):
    config = read(file)
    keys = {"runtime_mode", "postgres", "api_port", "web_port"}
    require(isinstance(config, dict) and keys <= config.keys()
            and config.keys() <= keys | {"simulation_responses_url", "simulation_scenario_file"}, "WORKBENCH_CONFIG_INVALID")
    mode = config["runtime_mode"]
    require(mode in {"REAL", "NATIVE_SIM"}, "WORKBENCH_RUNTIME_MODE_INVALID")
    require(all(validate_port(config[key]) for key in ("api_port", "web_port"))
            and config["api_port"] != config["web_port"], "WORKBENCH_LOOPBACK_PORTS_INVALID")
    pg = config["postgres"]
    require(isinstance(pg, dict) and {"host", "port", "user", "database"} == pg.keys()
            and all(isinstance(pg[key], str) for key in ("host", "user", "database"))
            and validate_port(pg["port"]), "WORKBENCH_POSTGRES_CONFIG_INVALID")
    real = mode == "REAL"
    require((pg["database"] == "ontoweave_publication_product_real" if real else
             re.fullmatch(r"ontoweave_publication_product_sim(?:_[a-z0-9_]{1,20})?", pg["database"])),
            "WORKBENCH_POSTGRES_DATABASE_NAME_INVALID")
    if "simulation_responses_url" in config:
        url = urlsplit(config["simulation_responses_url"])
        require(not real and url.scheme == "http" and url.hostname == "127.0.0.1"
                and url.port and url.path.endswith("/responses")
                and not (url.username or url.password or url.query or url.fragment),
                "WORKBENCH_SIMULATION_RESPONSES_URL_INVALID")
    if "simulation_scenario_file" in config:
        scenario = config["simulation_scenario_file"]
        require(not real and isinstance(scenario, str) and bool(scenario), "WORKBENCH_SIMULATION_SCENARIO_INVALID")
        path = (file.resolve().parent / scenario).resolve(strict=True)
        config["simulation_scenario_file"] = str(path)
    return config


def postgres_identity(path):
    pg = dict(isolated_pg(path))
    pg["dbname"] = pg.pop("database")
    try:
        with psycopg.connect(**pg, connect_timeout=5) as conn:
            conn.read_only = True
            row = conn.execute("""
                SELECT current_database(), current_user,
                       current_setting('port')::int, inet_server_addr() IS NULL,
                       system_identifier::text, current_setting('data_directory'),
                       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
                FROM pg_control_system()
            """).fetchone()
    except psycopg.Error as error:
        kind = "PG permission" if isinstance(error, psycopg.errors.InsufficientPrivilege) else "PG connection"
        raise ValueError(f"{kind} check failed. Verify the Unix socket, database, role and cluster identity access.") from error
    require(row[:4] == (pg["dbname"], pg["user"], pg["port"], True), "ISOLATED_DB_MISMATCH")
    require(row[6], "Install pgvector and run CREATE EXTENSION vector in the workbench database.")
    return {"system_id": row[4], "data_directory": row[5]}


def core_binary():
    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
    core = (ROOT / target / "debug/lightog-core").resolve()
    require(core.is_file() and os.access(core, os.X_OK), "Run cargo build --locked -p lightog-core.")
    return core


def parser_python():
    parser = ROOT / ".venv-docling312/bin/python"
    cache = STATE / "docling-models/tiktoken/9b5ad71b2ce5302211f9c61530b329a4922fc6a4"
    require(parser.is_file() and os.access(parser, os.X_OK)
            and cache.is_file() and digest(cache) == TOKENIZER_SHA256,
            "Run npm run setup:parser -- --yes to install Docling and prepare the local tokenizer.")
    return parser


def runtime_files(config, prepared, connection, folder):
    real = config["runtime_mode"] == "REAL"
    model_endpoint = config.get("simulation_responses_url", f"http://127.0.0.1:{config['api_port']}/responses")
    generation = GENERATION if real else dict(GENERATION, base_url=model_endpoint)
    codex = prepared["codex"]
    runtime_binding = {k: codex[k] for k in ("lock_file", "lock_sha256")}
    concurrency = 4
    native = {
        "mode": config["runtime_mode"], "concurrency": concurrency,
        "models": {"generation": dict(generation, endpoint_mode="responses", provider="HOST_CONFIGURED",
                                      profile_ref=f"WORKBENCH_{config['runtime_mode']}", protocol="responses")},
        "runtime_binding": runtime_binding, "codex_executable": codex["executable"],
        "execution_policy": "STOP_ON_KNOWN_FAILURE",
    }
    if real:
        native["material_binding"] = {"lock_file": str(PINS / "provider-material.json"), "lock_sha256": MATERIAL_SHA256}
    native_path = folder / "native-runtime.json"
    write(native_path, native)
    load_runtime(native_path, folder, configuration_only=True)
    index = {"segment_codepoints": 640}
    if real:
        index["embedding"] = dict(REAL_EMBEDDING, provider_identity="HOST_CONFIGURED", model_revision=None,
                                  max_input_utf8_bytes=2560, max_batch_utf8_bytes=12800,
                                  credential_file_env=CREDENTIAL_ENV)
    effective = {
        "mode": "PRODUCT_PG", "runtime_mode": config["runtime_mode"],
        "real_generation": real, "real_embedding": real, "unified_workbench_v2": True,
        "model_settings_enabled": True, "actor_ref": "ontoweave-local",
        "api_origin": f"http://127.0.0.1:{config['api_port']}", "web_port": config["web_port"],
        "libraries": [], "default_library_ref": None,
        "workspace_registry": {"connection_file": str(connection)},
        "apply_human_jobs": True, "review_domains": ["FACT", "IDENTITY", "ONTOLOGY"],
        "rust_binary": prepared["rust_binary"], "rust_sha256": prepared["rust_sha256"],
        "product": {"concurrency": concurrency, "parser_python": str(parser_python()),
                    "native_runtime_file": str(native_path), "run_root": str(STATE / "builds"),
                    "cluster_system_id": prepared["postgres_identity"]["system_id"],
                    "pg_data_directory": prepared["postgres_identity"]["data_directory"],
                    "embedding": REAL_EMBEDDING if real else SIM_EMBEDDING},
        "retrieval_index": index,
        "query": {"mode": config["runtime_mode"], "storage_directory": str(STATE / "query"),
                  "native_runtime_binding": runtime_binding, "generation": generation},
    }
    if "simulation_scenario_file" in config:
        effective["product"]["simulation_file"] = config["simulation_scenario_file"]
    return effective


def verify_codex(codex):
    baseline = read(PINS / "codex-protocol.json")
    file = Path(codex["lock_file"])
    require(digest(file) == codex["lock_sha256"], "NATIVE_RUNTIME_LOCK_CHANGED")
    lock = read(file)
    require(lock.pop("executable_sha256") == digest(Path(codex["executable"])) and lock == baseline,
            "CODEX_RUNTIME_CHANGED. Run npm run setup:workbench again with the pinned Codex version.")


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)


def ensure_ports(config):
    for key in ("api_port", "web_port"):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listener.bind(("127.0.0.1", config[key]))
            except OSError as error:
                raise ValueError(f"Port {config[key]} is unavailable. Choose a free {key}.") from error


def ready(url, child):
    deadline = monotonic() + 30
    opener = build_opener(ProxyHandler({}))
    while child.poll() is None and monotonic() < deadline:
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            sleep(.2)
    raise ValueError(f"Workbench service did not become ready at {url} (exit={child.poll()}).")


def run(config, prepared, effective):
    model_key = str(STATE / "operator/model.key")
    keys = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PGPASSFILE")
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update(PYTHONPATH=str(ROOT / "python"), PYTHONDONTWRITEBYTECODE="1",
               ONTOWEAVE_PG_CONFIG=str(effective), ONTOWEAVE_PG_WRITE_TOKEN=token_urlsafe(40),
               ONTOWEAVE_CODEX_EXECUTABLE=prepared["codex"]["executable"],
               ONTOWEAVE_NATIVE_SUCCESSOR_MANIFEST=str(PINS / "source.json"),
               ONTOWEAVE_NATIVE_SUCCESSOR_SHA256=SOURCE_MANIFEST_SHA256,
               ONTOWEAVE_PRODUCT_CREDENTIAL_FILE=model_key,
               ONTOWEAVE_QUERY_CREDENTIAL_FILE=model_key)
    env[CREDENTIAL_ENV] = model_key
    api_origin = f"http://127.0.0.1:{config['api_port']}"
    origin = f"http://127.0.0.1:{config['web_port']}"
    ensure_ports(config)
    with ExitStack() as stack:
        api = subprocess.Popen([sys.executable, "-B", "scripts/start-ontoweave-api.py", "--config", effective],
                               cwd=ROOT, env=env, start_new_session=True)
        stack.callback(stop, api)
        ready(f"{api_origin}/api/v1/libraries", api)
        web = subprocess.Popen(["node", "scripts/start-ontoweave.mjs"], cwd=ROOT, env=env, start_new_session=True)
        stack.callback(stop, web)
        ready(f"{origin}/api/bootstrap", web)
        print(f"OntoWeave workbench ready at {origin}", flush=True)
        while api.poll() is None and web.poll() is None:
            sleep(.25)
        raise ValueError(f"A workbench service exited (API={api.poll()}, web={web.poll()}).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup", "start"])
    parser.add_argument("--config", type=Path, default=STATE / "workbench.json")
    parser.add_argument("--codex", type=Path, help="Native Codex executable for setup")
    args = parser.parse_args()
    require(args.command == "setup" or not args.codex, "--codex applies to setup.")
    os.umask(0o077)
    private_directory(STATE)
    private_directory(STATE / "operator")
    os.environ["ONTOWEAVE_NATIVE_SUCCESSOR_MANIFEST"] = str(PINS / "source.json")
    os.environ["ONTOWEAVE_NATIVE_SUCCESSOR_SHA256"] = SOURCE_MANIFEST_SHA256
    verify_baseline()
    config = settings(args.config)
    prepared_path = STATE / "workbench-prepared.json"
    with (STATE / "workbench.lock").open("a") as lock, TemporaryDirectory(dir=STATE, prefix="workbench-") as scratch:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("This workbench is already starting or running.") from error
        folder = Path(scratch)
        connection = folder / "postgres.json"
        write(connection, config["postgres"])
        cluster = postgres_identity(connection)
        if args.command == "setup":
            parser_python()
            core = core_binary()
            if prepared_path.exists():
                previous = read(prepared_path)
                require(previous["postgres"] == config["postgres"] and previous["postgres_identity"] == cluster,
                        "This checkout is already bound to another PostgreSQL target. Use a separate checkout.")
            command = ["node", "scripts/setup-ontoweave-runtime.mjs"]
            if args.codex:
                command.append(f"--codex={args.codex.resolve()}")
            subprocess.run(command, cwd=ROOT, check=True)
            codex = read(STATE / "runtime.json")
            verify_codex(codex)
            prepared = dict(postgres=config["postgres"], postgres_identity=cluster, codex=codex,
                            rust_binary=str(core), rust_sha256=digest(core))
            runtime_files(config, prepared, connection, folder)
            write(prepared_path, prepared)
            print("Workbench setup complete. Model requests sent: 0.")
            return
        require(prepared_path.is_file(), "Run npm run setup:workbench before starting.")
        prepared = read(prepared_path)
        require(prepared["postgres"] == config["postgres"] and prepared["postgres_identity"] == cluster,
                "PRODUCT_PG_CLUSTER_CHANGED")
        require(digest(Path(prepared["rust_binary"])) == prepared["rust_sha256"],
                "RUST_BINARY_CHANGED. Build again and run npm run setup:workbench.")
        verify_codex(prepared["codex"])
        effective = folder / "effective.json"
        write(effective, runtime_files(config, prepared, connection, folder))
        run(config, prepared, effective)


if __name__ == "__main__":
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
