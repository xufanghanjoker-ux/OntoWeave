/** Explicit local integration test, including real Docling; no generation model calls. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createDocumentStore } from './documents.mjs';
import { fileURLToPath } from 'node:url';
const directory = new URL('../.ontoweave/parser-fixtures/', import.meta.url);
const store = createDocumentStore(fileURLToPath(new URL('../.ontoweave/parser-smoke/', import.meta.url)));
for (const name of ['synthetic-provider.docx', 'synthetic-provider.pdf', 'synthetic-scan.pdf']) {
  const r = await store.parse(readFileSync(new URL(name, directory)), name);
  for (const needle of ['44', '95%', 'does not claim']) assert(r.content.includes(needle), name + ': missing ' + needle);
  assert(r.blocks.every(b => r.content.slice(b.start, b.end).length > 0));
  if (name.endsWith('.docx')) assert(r.blocks.some(b => b.kind === 'table'));
  else assert(r.blocks.some(b => b.provenance.some(p => p.page_no >= 1 && p.bbox)));
  console.log(JSON.stringify({ file: name, document_id: r.document_id, parser_version: r.parser_version,
    characters: r.content.length, blocks: r.blocks.length, generation_model_calls: 0 }));
}
