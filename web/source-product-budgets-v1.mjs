/** Explicit product I/O authorization. Algorithm decisions remain in Rust. */
import {randomUUID} from 'node:crypto';
import{createSourceAutomaticExecution}from'./source-automatic-execution-v1.mjs';
const roles=['generation','embedding','reranker'];
const fail=code=>Object.assign(Error(code),{code,status:428,details:{billing_status:'NOT_SENT'}});
const need=(ok,code)=>{if(!ok)throw fail(code);};
export function createSourceProductBudgets({store,core}){
 const hash=value=>core('primitives','hash',value).canonical_hash,automatic=createSourceAutomaticExecution({store,core});
 const scope=p=>({version:'lightog-source-product-budget/1',input:p.budgetInput,context:p.budgetContext,source_stamp:p.sourceStamp,snapshot:p.snapshot,models:p.modelBindings});
 const binding=p=>hash(scope(p));
 function read(id){const row=typeof id==='string'?(store.getRecord('source_product_budget',id)??automatic.read(id)):null;return row?structuredClone(row):null;}
 function preview(prepared){
  const id=randomUUID(),row={id,scope_sha256:binding(prepared),library_id:prepared.sourceStamp.base_id,question:prepared.budgetContext.question,operation:prepared.budgetContext.operation,sources:prepared.budgetInput.sources.map(s=>({title:s.title,characters:s.content.length})),model_bindings:prepared.modelBindings,source_stamp:prepared.sourceStamp,preview:prepared.preview,created_at:new Date().toISOString()};
  row.rebuild_source_scope=prepared.budgetContext.rebuild_source_scope??false;row.proposal_policy_version=prepared.budgetContext.proposal_policy_version??null;store.putRecord('source_product_budget_preview',id,row);return {...row,requires_confirmation:true,automatic_retry:0};
 }
 function confirm({previewId,prepared,limits,consent}){
  need(consent===true,'SOURCE_BUDGET_CONSENT_REQUIRED');const p=store.getRecord('source_product_budget_preview',previewId);need(p&&p.scope_sha256===binding(prepared),'SOURCE_BUDGET_PREVIEW_STALE');
  need(limits&&typeof limits==='object'&&!Array.isArray(limits)&&Object.keys(limits).every(k=>roles.includes(k)),'SOURCE_BUDGET_LIMITS_REQUIRED');
  const caps=Object.fromEntries(roles.map(r=>[r,limits[r]??0]));need(roles.every(r=>Number.isSafeInteger(caps[r])&&caps[r]>=0&&caps[r]<=10000)&&roles.some(r=>caps[r]>0),'SOURCE_BUDGET_LIMITS_INVALID');
  need(roles.every(r=>caps[r]===0||prepared.modelBindings[r]),'SOURCE_BUDGET_MODEL_NOT_CONFIGURED');
  return store.transaction(()=>{const old=store.listRecords('source_product_budget').find(b=>b.preview_id===previewId);if(old){need(hash(old.limits)===hash(caps),'SOURCE_BUDGET_CONFIRMATION_CHANGED');return old;}
   const row={id:randomUUID(),preview_id:previewId,scope_sha256:p.scope_sha256,library_id:p.library_id,limits:caps,used:Object.fromEntries(roles.map(r=>[r,0])),model_bindings:p.model_bindings,source_stamp:p.source_stamp,status:'AUTHORIZED',created_at:new Date().toISOString()};
   store.archiveRecord('source_product_budget_authorization',row.id,row);store.putRecord('source_product_budget_authorization',row.id,row);store.putRecord('source_product_budget',row.id,row);return row;});
 }
 function authorize({budgetId,prepared}){if(automatic.read(budgetId))return automatic.authorize({budgetId,prepared});const b=read(budgetId);need(b&&b.status==='AUTHORIZED','SOURCE_BUDGET_REQUIRED');need(b.scope_sha256===binding(prepared),'SOURCE_BUDGET_SCOPE_CHANGED');return b;}
 function reserve(scopeInput,prepared){
  if(automatic.read(scopeInput.budgetId))return automatic.reserve(scopeInput,prepared);
  return store.transaction(()=>{const b=authorize({budgetId:scopeInput.budgetId,prepared}),r=scopeInput.capability;need(roles.includes(r),'SOURCE_BUDGET_CAPABILITY_INVALID');
   need(hash(scopeInput.budgetInput)===hash(prepared.budgetInput)&&hash(scopeInput.budgetContext)===hash(prepared.budgetContext)&&hash(scopeInput.sourceStamp)===hash(prepared.sourceStamp)&&hash(scopeInput.modelBinding)===hash(prepared.modelBindings[r]),'SOURCE_BUDGET_CALL_BINDING_CHANGED');
   need(b.used[r]<b.limits[r],'SOURCE_BUDGET_EXHAUSTED');b.used[r]++;store.putRecord('source_product_budget',b.id,b);
   const reservation={id:randomUUID(),budget_id:b.id,request_id:scopeInput.requestId,capability:r,phase:scopeInput.phase,index:b.used[r],limit:b.limits[r],billing_status:'RESERVED_NOT_PROOF_OF_SEND',created_at:new Date().toISOString()};
   store.putRecord('source_product_reservation',reservation.id,reservation);return reservation;});
 }
 return Object.freeze({preview,confirm,read,authorize,reserve,autoAuthorize:automatic.issue});
}
