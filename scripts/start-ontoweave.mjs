#!/usr/bin/env node
/** Loopback gateway launched by the managed PostgreSQL workbench. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPGWorkbench} from '../web/ontoweave-pg-gateway.mjs';

const pgConfig = process.env.ONTOWEAVE_PG_CONFIG;
if (!pgConfig) throw Error('ONTOWEAVE_PG_CONFIG_REQUIRED: launch the managed workbench with npm start.');
const config = JSON.parse(readFileSync(resolve(pgConfig), 'utf8'));
const webPort = Number(config.web_port);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) throw Error('ONTOWEAVE_WEB_PORT_INVALID');

const server = createPGWorkbench(config, process.env.ONTOWEAVE_PG_WRITE_TOKEN);
const stop = () => {
  server.close();
  server.closeAllConnections();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.listen(webPort, '127.0.0.1', () => console.log(`OntoWeave PG http://127.0.0.1:${webPort}`));
