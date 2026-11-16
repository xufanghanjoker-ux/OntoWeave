# Answer evidence deterministic API

Module `answer`, `answer::execute(op,payload)`. No model calls, streaming, retries, storage, clock or randomness. Existing generation/review prompts and model orchestration remain in JS. Synthesis evidence and contracts, final machine-readable values and excerpt candidates are constructed in Rust.

| op | payload | output |
|---|---|---|
| `build_evidence` | `{job,claims}` | Evidence index keyed by original claim ID. Validates source/support-set and uses existing `review::source_preview` with radius420/maxContext2200. |
| `validate` | `{raw,index,gate}` | Validated synthesis with normalized statement IDs, trimmed text, deduplicated citations; comparison subject and conflict completeness gates remain. |
| `validate_review` | `{review,draft}` | Boolean; invalid protocol/coverage rejects, REVISE returns false. Does not certify real-world truth. |
| `source_draft` | `{index,gate}` | Grouped excerpt draft; normally first3 per subject, all for CONFLICT. Keeps number/unit/comparator/scope/planned qualifiers. |
| `finish` | `{job,gate,index,draft,mode,reason?,review,meta:{answer_id,answered_at}}` | Original answer envelope, grouped typed values, deduplicated evidence, qualifiers, snapshot and full facts. Metadata comes from trusted host ID/clock. |
| `parse_json` | `{content,decoded?}` | JSON value after rejecting duplicate decoded object keys. Decoded duplicate keys such as `a` and `\u0061` collide. |

The model adapter first uses unchanged `parseModelJson(content)` to preserve native Node syntax diagnostics and JSON input decoding, then passes `{content,decoded}` to Rust. Rust owns the duplicate-key policy and scanning, returning decoded on success. This is input-decoder compatibility, not a JS domain-algorithm callback or fallback. Without `decoded`, Rust also parses syntactically valid JSON independently, but malformed serde error messages intentionally are not asserted equivalent to V8; the production wrapper must use the decoder path above.

Optional object fields remain omitted when the original JS object omitted undefined fields; explicit null values remain null. Object-values traversal respects JS array-index property ordering. Legacy side effects are absent; a constructed answer is still not a publication commit or model semantic review.

Validation: `fixtures/core-migration-v0.1/answer-differential.json` contains frozen original fixture/manual synthetic values; `local-runs/core-migration-v0.1/answer-real-differential-input.json` holds existing private-snapshot deterministic inputs and is not public. The latter uses synthetic review flags only to test protocol checks, not prove semantic quality.
