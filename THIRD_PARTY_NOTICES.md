# Third-party notices

OntoWeave uses Apache-2.0. Dependencies and bundled assets retain their upstream licenses.

- JavaScript versions: package-lock.json. Audit installed package metadata and license files before release.
- Graph bundles: web/assets/THIRD_PARTY_LICENSES.txt and linked bundle license files.
- Markdown bundles: web/assets/CHAT_MARKDOWN_THIRD_PARTY_LICENSES.txt.
- Geist and Manrope fonts: SIL OFL-1.1, retained in web/fonts/Geist-OFL.txt and Manrope-OFL.txt; provenance in web/fonts/README.md.
- Rust versions: Cargo.lock. Review license expressions for source and any distributed binaries.
- The PostgreSQL distribution and the pgvector extension are installed separately. Migration 012 uses pgvector.
- The Python API and PostgreSQL client dependencies are installed from `python/ontoweave_api/requirements.lock` and `requirements-pg-cq.lock`. The installed Psycopg, Psycopg Binary and Psycopg Pool distributions declare LGPL-3.0-only.
- Docling and parsing/OCR models are installed separately. Their code and model licenses apply independently. Weights are not bundled.
- Codex is separately installed; no desktop binary is redistributed.

Utopia, Graphiti and LightRAG informed product research. Preserve upstream LICENSE/NOTICE for any copied code. This inventory is not a completed compatibility audit; unresolved entries remain release blockers.
