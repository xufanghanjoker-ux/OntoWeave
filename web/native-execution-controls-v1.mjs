/** Normal product controls are local; explicit trial ledgers keep their quotas. */
export const PROGRESS_EXECUTION='PROGRESS_GOVERNED_V1';
export const NORMAL_NATIVE_LIMITS=Object.freeze({
 max_generation_requests:null,max_embedding_batches:null,max_embedding_items:null,
 max_embedding_text_chars:null,max_total_bytes:null,max_wall_ms:null,
 max_request_bytes:1048576,max_response_bytes:16777216,
 max_request_ms:600000,max_no_progress_ms:900000,max_stalled_tool_calls:3
});
export const progressExecution=state=>state.input?.execution_policy===PROGRESS_EXECUTION;
export const generationRemaining=state=>progressExecution(state)?null:state.limits.max_generation_requests-state.attempts.filter(a=>a.kind==='GENERATION').length;
export const canGenerate=(state,count=1)=>generationRemaining(state)===null||generationRemaining(state)>=count;
export const wholeRunRemaining=(state,now=Date.now())=>progressExecution(state)?null:Math.max(0,state.limits.max_wall_ms-(state.started_at===null?0:now-state.started_at));
export const localRuntimeTimeout=state=>progressExecution(state)?state.limits.max_no_progress_ms:Math.max(1,wholeRunRemaining(state));
