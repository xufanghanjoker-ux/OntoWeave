/** Register the existing native Codex query product against an isolated PG workbench. */
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

import { createStore } from "./store.mjs";
import { createSourceModels } from "./source-models-v1.mjs";
import { createNativeQueryProduct } from "./native-query-product-v1.mjs";
import { createNativeQueryHttp } from "./native-query-http-v1.mjs";
import { createPgQueryPort } from "./native-query-pg-v3.mjs";
import { NATIVE_CODEX_EXECUTABLE, resolveNativeRuntimeSelection } from "./native-agent-runtime-v1.mjs";

const REAL_RESPONSES = "https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/responses";
const fail = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });

function credential() {
  const path = process.env.ONTOWEAVE_QUERY_CREDENTIAL_FILE ?? process.env.ONTOWEAVE_PRODUCT_CREDENTIAL_FILE;
  if (!path) throw fail("QUERY_GENERATION_CREDENTIAL_REQUIRED");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 8192) {
      throw fail("QUERY_GENERATION_CREDENTIAL_PERMISSIONS");
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!value || /\s/u.test(value)) throw fail("QUERY_GENERATION_CREDENTIAL_INVALID");
    return value;
  } finally {
    closeSync(fd);
  }
}

async function parseBody(req) {
  if (!String(req.headers["content-type"]).startsWith("application/json")) throw fail("QUERY_CONTENT_TYPE_INVALID");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 262_144) throw fail("QUERY_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail("QUERY_INPUT_JSON_INVALID");
  }
}

function queryUpstream(query, store, rotatingCredential) {
  const generation = query.generation;
  if (!generation || generation.model !== "qwen3.8-flash" || generation.reasoning_effort !== "low") {
    throw fail("QUERY_GENERATION_PROFILE_INVALID");
  }
  const endpoint = new URL(generation.base_url);
  const real = query.mode === "REAL";
  const sim = query.mode === "NATIVE_SIM" && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1";
  if ((!real || endpoint.href !== REAL_RESPONSES) && !sim) throw fail("QUERY_GENERATION_ENDPOINT_INVALID");
  if (!endpoint.pathname.endsWith("/responses") || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw fail("QUERY_GENERATION_ENDPOINT_INVALID");
  }
  const load = () => {
    const models = createSourceModels({store});
    models.configure("generation", {
      enabled: true, model: generation.model, protocol: "openai-compatible", endpoint_mode: "full",
      base_url: endpoint.href, ...(real ? {api_key:credential()} : {}),
    });
    return models.nativeModelRuntime();
  };
  const established = real && rotatingCredential ? null : load();
  return () => {
    const configured = established ?? load();
    return {...configured, profile: {...configured.generation, provider:"HOST_CONFIGURED",
             profile_ref:"PG_RETRIEVAL_NATIVE_PROFILE", protocol:"responses"}};
  };
}

export function registerPgQuery({query, endpoint, writeToken, authorizeLibrary, json, rotatingCredential=false}) {
  if (!query) return null;
  const binding = query.native_runtime_binding;
  if (!binding || typeof binding.lock_file !== "string" || !/^[0-9a-f]{64}$/.test(binding.lock_sha256 ?? "")) {
    throw fail("QUERY_NATIVE_RUNTIME_BINDING_REQUIRED");
  }
  const lockedRuntime = {lock_file: binding.lock_file, lock_sha256: binding.lock_sha256};
  const choice = resolveNativeRuntimeSelection(lockedRuntime);
  const digest = createHash("sha256").update(readFileSync(NATIVE_CODEX_EXECUTABLE)).digest("hex");
  if (digest !== choice.lock.executable_sha256 ||
      (binding.executable && resolve(binding.executable) !== resolve(NATIVE_CODEX_EXECUTABLE))) {
    throw fail("QUERY_NATIVE_RUNTIME_EXECUTABLE_CHANGED");
  }
  if (typeof query.storage_directory !== "string" || !query.storage_directory.startsWith("/")) {
    throw fail("QUERY_STORAGE_DIRECTORY_REQUIRED");
  }
  const storage = resolve(query.storage_directory);
  mkdirSync(storage, {mode:0o700, recursive:true});
  const info = statSync(storage);
  if (info.uid !== process.getuid() || (info.mode & 0o077)) throw fail("QUERY_STORAGE_DIRECTORY_NOT_PRIVATE");
  const store = createStore(storage);
  try {
    const pgQueryPort = createPgQueryPort({request:async ({libraryId, action, body, signal}) => {

      const path = "/_ontoweave/query/" + encodeURIComponent(libraryId) + "/" + encodeURIComponent(action);
      let response, data;
      try {
        const timeout = AbortSignal.timeout(150_000);
        response = await fetch(new URL(path, endpoint), {
          method:"POST", redirect:"error", headers:{"Content-Type":"application/json", "X-Ontoweave-Write-Token":writeToken},
          body:JSON.stringify(body), signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
        });
        data = await response.json();
      } catch {
        if (action === "call") throw fail("QUERY_PG_TOOL_OUTCOME_UNKNOWN",{billing_status:"UNKNOWN"});
        throw fail("QUERY_PG_UNAVAILABLE");
      }
      if (!response.ok) throw fail(data.error?.code ?? "QUERY_PG_UNAVAILABLE");
      return data;
    }});
    const product = createNativeQueryProduct({
      store, pgQueryPort, nativeRuntimeBinding:lockedRuntime, modelRuntime:queryUpstream(query, store, rotatingCredential),
      runtimeDirectory:resolve(storage,"native-query-runtime"),
    });
    const handle = createNativeQueryHttp({
      product, json, parseBody,
      authorize:async ({req,libraryId,action}) => {
        const origin = req.headers.origin;
        const local = "http://" + req.headers.host;
        if (req.headers["sec-fetch-site"] === "cross-site" ||
            !(req.method === "POST" ? origin === local : !origin || origin === local)) return false;
        return authorizeLibrary(libraryId, action);
      },
    });
    return {handle, close: async () => { try {await product.close();} finally {store.close();} }};
  } catch (error) {
    store.close();
    throw error;
  }
}
