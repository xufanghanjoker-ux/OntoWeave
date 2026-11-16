import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';

const CONTENT='native_organization_content_v1',DELIVERY='native_organization_delivery_v1';
const mergeRanges=ranges=>ranges.sort((a,b)=>a[0]-b[0]).reduce((out,r)=>{const last=out.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);return out;},[]);
/** Actual delivered bytes, scoped to one independent Agent context. Never grants read credit from a reference. */
export function createVersionedDeliveryLedger({store,scope,sourceBinding}){
 need(textField(scope)&&sourceBinding!==undefined,'NATIVE_DELIVERY_BINDING_REQUIRED');
 const binding=hash(sourceBinding),key=contentRef=>hash([scope,contentRef]);
 function deliverPage(page,{kind,purpose,resolveRecord,force=false}={}){
  need(['SEMANTIC','KNOWLEDGE','ADJACENCY'].includes(kind)&&Array.isArray(page.items),'NATIVE_DELIVERY_PAGE_INVALID');
  const field=kind==='SEMANTIC'?'semantic_ref':'knowledge_ref';
  return store.transaction(()=>({...clone(page),items:page.items.map(item=>{
   const ref=item[field];need(textField(ref),'NATIVE_DELIVERY_REF_REQUIRED');
   const fragment=typeof item.fragment_json==='string';
   const record=fragment?resolveRecord?.(ref):item;
   need(record&&record[field]===ref&&!Object.hasOwn(record,'fragment_json'),'NATIVE_DELIVERY_CANONICAL_RECORD_REQUIRED');
   const serialized=JSON.stringify(record),version=hash([binding,serialized]),contentRef='content_'+hash([binding,kind,ref,version]);
   const body={content_ref:contentRef,content_version:version,source_binding:binding,kind,ref,serialized,record_sha256:hash(record)};
   const oldContent=store.getRecord(CONTENT,contentRef);need(!oldContent||hash(oldContent)===hash(body),'NATIVE_DELIVERY_CONTENT_CONFLICT');
   if(!oldContent)store.putRecord(CONTENT,contentRef,body);
   const start=fragment?item.offset:0,end=fragment?start+item.fragment_json.length:serialized.length;
   need(Number.isSafeInteger(start)&&start>=0&&end<=serialized.length&&(!fragment||item.total_chars===serialized.length&&item.fragment_json===serialized.slice(start,end)&&item.complete===(end===serialized.length)),'NATIVE_DELIVERY_FRAGMENT_MISMATCH');
   const old=store.getRecord(DELIVERY,key(contentRef)),ranges=old?.ranges??[],covered=ranges.some(([a,b])=>a<=start&&b>=end);
   const nextRanges=mergeRanges([...ranges,[start,end]]),complete=nextRanges.length===1&&nextRanges[0][0]===0&&nextRanges[0][1]===serialized.length;
   store.putRecord(DELIVERY,key(contentRef),{scope,source_binding:binding,content_ref:contentRef,content_version:version,kind,ref,total_chars:serialized.length,ranges:nextRanges,complete,purposes:[...new Set([...(old?.purposes??[]),...(purpose?[purpose]:[])])]});
   const metadata={content_ref:contentRef,content_version:version,record_delivery_complete:complete};
   return covered&&!force?{[field]:ref,...metadata,already_delivered:true,...(fragment?{offset:start,total_chars:serialized.length,range_end:end}:{}),...(purpose?{purpose}: {})}:{...clone(item),...metadata};
  })}));
 }
 function readContent(contentRef){const value=store.getRecord(CONTENT,contentRef);need(value&&value.source_binding===binding,'NATIVE_DELIVERY_CONTENT_NOT_FOUND');return JSON.parse(value.serialized);}
 function snapshot(){return {scope,source_binding:binding,delivered:store.listRecords(DELIVERY).filter(r=>r.scope===scope&&r.source_binding===binding).map(clone)};}
 return {deliverPage,readContent,snapshot};
}
