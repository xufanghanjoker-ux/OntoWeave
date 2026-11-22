import {request} from 'node:http';

import {readRPCInput} from './native-rpc.mjs';

// stdin data events can split a UTF-8 code point.
const {url, token, body} = await readRPCInput(process.stdin);
const req = request(url, {
  method: 'POST',
  headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
}, res => res.pipe(process.stdout));
req.on('error', () => { process.exitCode = 2; });
req.end(JSON.stringify(body));
