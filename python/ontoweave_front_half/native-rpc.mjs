import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';

const RESPONSE_LIMIT = 64000000;
const REQUEST_TIMEOUT_MS = 60000;
const ERROR = 2;
const failure = code => Object.assign(Error(code), {code});

/** Keep the existing synchronous record API while one Worker owns the HTTP connection.
 * A timeout poisons the channel. Mutating operations are never automatically resent.
 */
export function createRPC(input) {
  const target = new URL(input.rpc_url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password ||
      target.search || target.hash || target.pathname !== '/') throw failure('PYTHON_RPC_TARGET_INVALID');
  const controlBuffer = new SharedArrayBuffer(8);
  const outputBuffer = new SharedArrayBuffer(RESPONSE_LIMIT);
  const control = new Int32Array(controlBuffer);
  const output = new Uint8Array(outputBuffer);
  const channel = randomUUID();
  const worker = new Worker(new URL('./native-rpc-worker.mjs', import.meta.url), {
    workerData: {url: target.href, token: input.rpc_token, controlBuffer, outputBuffer},
  });
  // The bridge's normal process lifetime owns this helper.
  worker.unref();
  let sequence = 0;
  let closed = false;
  const metrics = {worker_starts: 1, calls: 0, wall_ms: 0, request_bytes: 0, response_bytes: 0};
  const close = () => {
    if (!closed) {
      closed = true;
      worker.terminate().catch(() => {});
    }
  };
  const rpc = (op, args = {}) => {
    if (closed) throw failure('PYTHON_RPC_CHANNEL_CLOSED');
    const body = JSON.stringify({scope: input.agent_scope, op, args, rpc_channel: channel, rpc_sequence: ++sequence});
    if (Buffer.byteLength(body) > RESPONSE_LIMIT) throw failure('PYTHON_RPC_REQUEST_TOO_LARGE');
    const started = performance.now();
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    worker.postMessage(body);
    if (Atomics.wait(control, 0, 0, REQUEST_TIMEOUT_MS) === 'timed-out') {
      close();
      throw failure('PYTHON_RPC_OUTCOME_UNKNOWN');
    }
    metrics.calls++;
    metrics.wall_ms += performance.now() - started;
    metrics.request_bytes += Buffer.byteLength(body);
    const length = Atomics.load(control, 1);
    metrics.response_bytes += length;
    const raw = Buffer.from(output.subarray(0, length)).toString('utf8');
    if (Atomics.load(control, 0) === ERROR) {
      close();
      throw failure(raw || 'PYTHON_RPC_OUTCOME_UNKNOWN');
    }
    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      close();
      throw failure('PYTHON_RPC_RESPONSE_INVALID');
    }
    if (response.error) throw failure(response.error);
    return response.result;
  };
  rpc.close = close;
  rpc.metrics = () => ({...metrics, channel, sequence, closed});
  return rpc;
}

/** Shared store representation for the Python role bridges. */
export function createRPCStore(rpc) {
  let rows = null;
  let pending = [];
  const keyOf = (kind, key) => JSON.stringify([kind, key]);
  const store = {
    getRecord(kind, key) {
      return rows ? structuredClone(rows.get(keyOf(kind, key))?.payload ?? null) : rpc('get', {kind, key});
    },
    putRecord(kind, key, payload) {
      if (rows) {
        const row = {kind, key, payload: structuredClone(payload)};
        rows.set(keyOf(kind, key), row);
        pending.push(row);
        return payload;
      }
      return rpc('put', {kind, key, payload});
    },
    listRecords(kind) {
      return rows ? [...rows.values()].filter(row => row.kind === kind).map(row => structuredClone(row.payload)) :
        rpc('list', {kind});
    },
    putRecords(batch) {
      if (rows) {
        for (const row of batch) store.putRecord(row.kind, row.key, row.payload);
        return;
      }
      rpc('batch', {rows: batch});
    },
    transaction(fn) {
      if (rows) return fn();
      rows = new Map(rpc('rows').map(row => [keyOf(row.kind, row.key), row]));
      pending = [];
      try {
        const result = fn();
        if (result?.then) throw failure('PYTHON_RPC_TRANSACTION_MUST_BE_SYNCHRONOUS');
        rpc('batch', {rows: pending});
        return result;
      } finally {
        rows = null;
        pending = [];
      }
    },
  };
  return store;
}

export async function readRPCInput(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
