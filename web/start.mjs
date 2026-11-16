// Check prerequisites before importing node:sqlite, so unsupported Node receives actionable guidance.
import { supportedNode } from './runtime.mjs';
if (!supportedNode()) throw Error('需要 Node 22.22+ 或24.15+（仅22/24版本线）：https://nodejs.org/en/download');
await import('../scripts/build-graph.mjs');
const { startWorkbench } = await import('./server.mjs');
await startWorkbench();
