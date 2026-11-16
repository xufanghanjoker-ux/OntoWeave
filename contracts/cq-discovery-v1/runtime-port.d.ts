/** Application domain port, not OpenAI SDK/App Server RPC types. */
export type DiscoveryState = 'QUEUED' | 'RUNNING' | 'WAITING_CONFIGURATION' | 'SUCCEEDED' | 'PARTIAL' | 'CANCELLED' | 'STALE' | 'FAILED' | 'UNKNOWN_HOLD';
export type Stage = 'CQ' | 'FAMILY' | 'SCOPE';
export interface SourceHintInput {doc_id: string; revision: string; block_id?: string}
export interface SourceHint extends SourceHintInput {resolution: 'VALID' | 'UNLOCATED' | 'INVALID_REF' | 'STALE'}
export interface UpstreamRef {artifact_id: string; version: 1}
export interface StageSubmission {
  work_unit_id: string;
  stage: Stage;
  input_snapshot_id: string;
  upstream_artifact_refs: UpstreamRef[];
  input_read_refs?: string[];
  expected_draft_revision: number;
  idempotency_key: string;
  payload: Record<string, unknown>; // stage-submission.schema.json + host referential checks
  plan_change_request?: unknown;
}
export interface RuntimeCapabilities {
  port: 'lightog_agent_runtime_v1';
  kind: 'OFFLINE_STUB' | 'CODEX_UNCONNECTED';
  available: boolean;
  per_request_gate_verified: false; // CQ-1 cannot promise a real inference hard gate
  compatibility?: 'UNKNOWN';
  reason?: string;
  version?: string;
  model?: 'qwen3.8-flash';
  external_requests?: 0;
}
export interface WorkUnit {
  work_unit_id: string;
  stage: Stage;
  doc_ids: string[];
  depends_on: string[];
  read_policy?: 'SELECTIVE_BODY';
}
export interface RuntimeJob {
  task_id: string;
  request_id: string;
  snapshot_id: string;
  contract: 'lightog_cq_stage_v1';
  model: 'qwen3.8-flash';
  skill: {id: 'lightog-cq-discovery'; version: 'NOT_INSTALLED'};
  allowed_tools: string[];
  resource_limits: {max_requests: number; max_input_tokens: number; max_output_tokens: number; max_concurrency: number; max_duration_ms: number};
  purpose: string;
  seed_questions: string[];
  work_units: WorkUnit[];
}
export interface RuntimeHandle {runtime_id: string; request_id: string}
export type RuntimeEvent = {
  event_id: string;
  type: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  usage?: {input_tokens: number; output_tokens: number};
  code?: string;
  external_requests: 0;
};
export interface AgentRuntimePort {
  capabilities(): Promise<RuntimeCapabilities>;
  start(job: RuntimeJob): Promise<RuntimeHandle>;
  observe(handle: RuntimeHandle, afterEvent?: string): AsyncIterable<RuntimeEvent>;
  interrupt(handle: RuntimeHandle): Promise<{confirmed: boolean; reason?: string; remote_nonexecution_proven?: false}>;
}
// The fixture callback also receives toolsFor(workUnitId) and budget_kind.
// Those in-process functions are not serialized into durable jobs or RPC.
