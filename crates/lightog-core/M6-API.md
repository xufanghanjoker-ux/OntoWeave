# M6 review/governance pure-operation API

Frozen reference: `fixtures/core-migration-v0.1/reference/`. Equivalent rules only; no model, database, filesystem, clock, authorization, or production-service operations in these modules.

Both files export `pub fn execute(op: &str, payload: &Value) -> Result<Value>`.

## review module

| operation | payload | result |
| --- | --- | --- |
| `source_preview` | `{source,claim,options:{radius?,maxContext?}}` | frozen original UTF16 source-preview result |
| `make_packet` | `{input,proposal,version,options:{packet_id,structuralCandidates?}}` | frozen review packet; host must supply random packet_id |
| `packet_hash` | `{packet}` | canonical SHA-256 string |
| `diagnose_review` | `{packet,review}` | ordered diagnostic array |
| `decide_review` | `{packet,review,validation,execution}` | original action/reason/issues/optional diagnostics; both assurance flags remain false |
| `review_targets` | `{proposal}` | original ordered target menu, stable refs, pointers, kinds, labels, fields |
| `compile_review` | `{packet,raw,options:{quarantineObservations?}}` | original compiled review/diagnostics/quarantined_observations/valid |

`source_preview`, `make_packet`, `packet_hash`, `diagnose_review`, `decide_review`, `review_targets`, `compile_review` are also public Rust functions. The prompt remains a JS model adapter; it is not an algorithm migration. The host must build execution and deterministic-validation metadata from actual trusted run records. Rust only validates the supplied envelope; metadata copied from model output does not become trustworthy.

## governance standalone operations

| operation | payload | result |
| --- | --- | --- |
| `source_key` | `{source}` | original `src_...` identity |
| `plan_component_publication` | `{base,job,options:{allowUnchanged?,allowNoIssues?}}` | original eligible/reason/hold or candidate/manifest/hash; it is not a publish receipt |
| `knowledge_bases` | `{tasks:[...]}` | original revision-ancestry grouping and ordered library descriptors |

Component planning internally calls the shared model schema/query checks, evidence claim validation and learning extension checks. Unsupported dependency fields remain unsupported. Union-find preserves the original insertion/root choice and hash inputs.

## snapshot operations

All remaining operations accept `snapshot:{tasks:[task,...],records:[{kind,id,value},...]}`. `payload` is accepted as an alternative to `value` on an input record. Tasks and records must be complete trusted service snapshots, with each record-kind list retaining the order returned by the original store. No default service lookup occurs.

| operation | extra payload fields | result |
| --- | --- | --- |
| `begin` | `job` | `{result: original candidate or null,writes:[...]}` |
| `publish` | `job,now` | `{result: original publication or null,writes:[...]}` |
| `revoke` | `base_id,key,now` | `{result: original next state,writes:[...]}` |
| `add_source` | `base_id,source,now` | `{result:{state,added},writes:[...]}` |
| `replace_source` | `base_id,key,source,now` | `{result:{state,changed},writes:[...]}` |
| `view` | `job` | original source/controversy-filtered job view |
| `stamp` | `task_id` | original source/review stamp or null |
| `assert_stamp` | `expected` | null on success; original typed rejection on mismatch |
| `assert_candidate_sources` | `task_id` | null on success; SOURCE_REVOKED with NOT_SENT detail if stale |
| `query` | `task_id,plan,input?` | original answer result plus SQLITE backend/task/version |
| `libraries` | none | original active publication-aware library list |
| `base_for` | `base_id` | original library_state record or null |
| `candidate_for` | `task_id` | original library_candidate record or null |
| `review_hash` | `base_id,source_epoch` | original pending-review hash |

`now` must be a service-generated ISO timestamp, not model data. It is only required when the original operation actually creates a time-bearing change. No-op/idempotent paths do not acquire a new time.

Writes have one of these forms, in original transactional order:

- `{op:"put_record",kind,id,value}`
- `{op:"save_task",task}`

A failure returns no write set. The host must read the current snapshot and apply all returned writes atomically within the trusted service transaction. If any state can change while an async Rust call is in flight, re-read and reject/recompute before committing. The write set is a deterministic proposal, not authorization. Library lifecycle/authentication, task ownership, actual baseline execution, current source/head/revision rechecks, budget/model calls, queue dispatch and database transaction control remain with the host.

`LIBRARY_UNAVAILABLE` corresponds to the original lifecycle rejection; the HTTP adapter must preserve its 410 status. Algorithm assertions use the common core error contract and retain their original messages. JSON absent fields are kept absent when the original serialized result omitted them; null is not generally a synonym for an absent input field.
