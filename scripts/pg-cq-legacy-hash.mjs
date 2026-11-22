// Migration-only read-only compatibility seam for existing JS canonical signatures.
// No DB, network, Agent, range selection, or storage implementation lives here.
import {hash} from '../web/cq-discovery-store-v2.mjs';
let input='';for await(const part of process.stdin)input+=part;
const values=JSON.parse(input);if(!Array.isArray(values))throw Error('EXPECTED_HASH_BATCH');
process.stdout.write(JSON.stringify(values.map(hash)));
