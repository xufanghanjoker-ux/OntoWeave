/** One HTTP Agent for the lifetime of a Python role invocation. */
import {Agent, request} from 'node:http';
import {parentPort, workerData} from 'node:worker_threads';

const control = new Int32Array(workerData.controlBuffer);
const output = new Uint8Array(workerData.outputBuffer);
const agent = new Agent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1});
let active = false;

function answer(bytes, status) {
  const data = Buffer.from(bytes);
  const oversized = data.length > output.length;
  const retained = oversized ? Buffer.from('PYTHON_RPC_RESPONSE_TOO_LARGE') : data;
  output.set(retained);
  Atomics.store(control, 1, retained.length);
  Atomics.store(control, 0, oversized ? 2 : status);
  Atomics.notify(control, 0);
}

parentPort.on('message', body => {
  if (active) {
    answer('PYTHON_RPC_CONCURRENT_CALL', 2);
    return;
  }
  active = true;
  let settled = false;
  const finish = (bytes, status) => {
    if (settled) return;
    settled = true;
    active = false;
    answer(bytes, status);
  };
  const req = request(workerData.url, {
    method: 'POST', agent,
    headers: {authorization: 'Bearer ' + workerData.token, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)},
  }, response => {
    let total = 0;
    const chunks = [];
    response.on('data', part => {
      total += part.length;
      if (total > output.length) req.destroy(Error('PYTHON_RPC_RESPONSE_TOO_LARGE'));
      else chunks.push(part);
    });
    response.on('end', () => {
      if (response.statusCode !== 200) finish('PYTHON_RPC_OUTCOME_UNKNOWN', 2);
      else finish(Buffer.concat(chunks), 1);
    });
    response.on('error', () => finish('PYTHON_RPC_OUTCOME_UNKNOWN', 2));
  });
  req.setTimeout(55000, () => req.destroy(Error('PYTHON_RPC_TIMEOUT')));
  req.on('error', () => finish('PYTHON_RPC_OUTCOME_UNKNOWN', 2));
  req.end(body);
});
