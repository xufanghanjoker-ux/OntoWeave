# M4/M5 deterministic snapshot API

Migration only. These operations do not run a model, access files or a database, obtain time, publish a task, or activate a product path. Dispatch through `retrieval::execute(op,payload)` and `learning::execute(op,payload)`. JSON member order from the legacy serialization boundary must be preserved; ordinary object structural comparisons are member-order independent. Arrays keep their original order.

## M4 / retrieval

| op | payload | result |
|---|---|---|
| `source.extraction_units` | `{sources, options?:{maxChars,overlap}}` | Legacy extraction units array, original source order and UTF16 positions/IDs |
| `source.context_sources` | `{sources,cqs,options?:{maxChars}}` | Legacy sampled source contexts array |
| `source.claim_review_batches` | `{claims,options?:{maxClaims,maxChars}}` | Legacy review batches array, projected claims and full-snapshot indices |
| `index.keys` | `{base_id,sources}` | Index IDs in source order; host reads each via getRecord |
| `index.ensure` | IndexSnapshot | `{units,rows,writes}` |
| `index.enrich` | IndexSnapshot plus `scope_row` | `{units,rows,writes}` |
| `index.rank` | IndexSnapshot plus `question,claims?` | `{units,rows,writes,ranked}` |
| `index.plan` | IndexSnapshot plus `question,claims?,evidence` | `{units,rows,writes,ranked,plan}` |
| `index.expand` | IndexSnapshot plus `question,claims?,previous` | `{units,rows,writes,ranked,plan}` |
| `index.validate_plan` | `{plan,sources,evidence?:[]}` | Selected units in original extraction order, not ranking order |

`IndexSnapshot = {base_id,sources,entities?:[],rows?:[],created_at}`. `rows` is the store's existing `learning_source_index` snapshot; host may supply all relevant rows. `created_at` is the host-supplied timestamp used only when rebuilding rows; existing valid rows retain their timestamp. The host must read current effective sources. The kernel validates content SHA and index row digests; it cannot infer source revocation omitted by the host.

`writes = [{kind:"learning_source_index",id,value}]`; host applies writes in order. `enrich` can return both an initial ensure write and a later enriched write for the same id, preserving the original two-step effect. No hidden storage state exists in the Rust operation. A subsequent operation must receive rows after the prior host-applied writes.

`source.*` operations additionally accept unprefixed aliases `extraction_units`, `context_sources`, `claim_review_batches`. `index.validate_plan` also accepts `validate_learning_plan`.

## M5 / learning

| op | payload | result |
|---|---|---|
| `validate_extension` | `{schema,previous,options?:{resolvableIds:[]}}` | Original schema or assertion error |
| `simple_attribute_extension` | `{schema,extension,requirements}` | Boolean (shape gate only, not fact approval) |
| `extension_extraction_schema` | `{schema,previous,options?:{targetPredicateIds:[]}}` | `{schema,new_subject_ids}` |
| `select_units` | `{units,question}` | Same units, matching partition first, none discarded |
| `evidence_units` | `{units,evidence,sources}` | All overlapping units after exact anchor checks |
| `additive_review_selection` | `{claims,retained?:[]}` | `{claims,indices}` (only newly added claims) |
| `dimension` | `{schema,extractionSchema,cqs,definitions?:"",as_of?:null,contract?}` | Legacy canonical dimension hash string |
| `ledger.key` | `{base_id,dimension,unit}` | Receipt ID; host reads via getRecord |
| `ledger.lookup` | `{base_id,dimension,unit,retained,row}` | Exact reusable receipt or null |
| `ledger.commit` | `{base_id,job,published?:false}` | `{writes:[{kind:"learning_processed_dimension",id,value}]}` |
| `resolve_holds` | HoldSnapshot | `{resolved:[hold_id],writes:[{kind:"component_hold",id,value}]}` |

`HoldSnapshot = {job,tasks,holds,library_candidates,library_states,review_contract_rechecks}`. Arrays preserve store-returned order. `library_candidates` rows are indexed by `task_id`; `library_states` rows by `id`; `tasks` are the current task/ancestor/origin snapshots; the other arrays correspond to the legacy `listRecords` calls.

The caller must provide a trusted `published` state for ledger commit, not a model assertion. Before applying hold write sets, JS must recheck the actual transaction's current published head/source epoch and maintain the same business authorization. Rust eligibility does not commit publication or supersede saved human decisions. Empty writes remain empty, not an implicit approval.

Aliases: `select_learning_units`, `evidence_learning_units`, `extraction_dimension`, `resolve_learning_holds`.

## Preservation boundaries

- M4 raw-order `sha` and M5 canonical `canonical_hash` remain distinct. Ledger layout hashes use the raw-order serializer; dimensions first locale-sort raw plan JSON strings then canonical-hash.
- UTF16 budgets and spans, NFKC lexical ranking, source-order ties, exact old-field preservation, SOURCE_CONTEXT_VERSION and LEARNING_INDEX_VERSION remain unchanged.
- `select_units` deliberately preserves the legacy mixed code-point iteration/UTF16 slicing behavior for supplementary Han characters; this migration does not fix it.
- No knowledge merging, arbitrary identity consolidation, semantic binding or relevance certification is introduced.
- JSON cannot faithfully transport JS `undefined` values or lone-surrogate strings as normal Rust strings. Host adaptation must explicitly classify such unsupported representations rather than silently normalize facts or IDs. Valid existing product snapshots and migration fixtures are the immediate compatibility domain.

Math compatibility: ranking uses the Node v22.22.1 V8/fdlibm `log` rounding sequence rather than platform `ln`; the exact source and full upstream Sun/V8 copyright and permission notices are retained beside the function in `retrieval.rs`. This is an equivalent math-port correction, not a scoring change or epsilon policy.
