/** Direct bounded knowledge search for the shared memory facade. No agent or providers. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {createExtractedQuerySearch} from './native-query-extracted-reader-v1.mjs';
import {modelRow,publicCitation} from './native-query-delivery-view-v1.mjs';

export function createMemoryKnowledgeSearchPort({resolveReader}){
 need(typeof resolveReader==='function','MEMORY_SEARCH_READER_REQUIRED');
 const readers=new Map(),cursors=new Map();
 function currentView(reader,libraryId){reader.assertCurrent();const pin=reader.pin();need(pin.library_id===libraryId,'MEMORY_SEARCH_SCOPE_MISMATCH');const receipt=reader.publicationView?.();return {library_id:libraryId,reader_pin:clone(pin),...(receipt?{commit_ref:receipt.commit_ref,confirmation_ref:receipt.confirmation_ref,bindings:clone(receipt.bindings)}:{})};}
 function matches(view,expected){if(!expected)return;need(view.library_id===expected.library_id&&view.commit_ref===expected.commit_ref&&view.confirmation_ref===expected.confirmation_ref&&hash(view.bindings??null)===hash(expected.bindings??null),'MEMORY_SEARCH_PIN_MISMATCH');}
 async function search({library_id,query,page_size=10,cursor,view}){
  need(textField(library_id)&&textField(query),'MEMORY_SEARCH_SCOPE_REQUIRED');need(Number.isSafeInteger(page_size)&&page_size>=1&&page_size<=50,'MEMORY_PAGE_SIZE_INVALID');
  let entry;
  if(cursor){entry=cursors.get(cursor);need(entry&&entry.library_id===library_id&&entry.query===query&&entry.page_size===page_size,'MEMORY_SEARCH_CURSOR_INVALID');}
  else{const reader=await resolveReader(library_id);need(reader,'MEMORY_SEARCH_READER_REQUIRED');const pin=currentView(reader,library_id),key=hash(pin);entry=readers.get(key);if(!entry){entry={library_id,reader,view:pin,search:createExtractedQuerySearch({reader,rankingOptions:{enabled:false}})};readers.set(key,entry);}}
  const before=currentView(entry.reader,library_id);need(hash(before)===hash(entry.view),'MEMORY_SEARCH_PIN_MISMATCH');matches(before,view);
  const result=await entry.search.searchFacts({query,page_size,...(cursor?{cursor}:{})});
  const after=currentView(entry.reader,library_id);need(hash(after)===hash(before),'MEMORY_SEARCH_PIN_MISMATCH');
  const items=result.items.map(row=>({...modelRow(row),citation:publicCitation(entry.reader.graphBundle([row.fact_ref,...(row.duplicate_record_refs??[])]))}));
  if(result.next_cursor)cursors.set(result.next_cursor,{...entry,query,page_size});
  return {items,next_cursor:result.next_cursor,view:after};
 }
 async function assertCurrent({library_id,view}){need(textField(library_id)&&view?.library_id===library_id,'MEMORY_SEARCH_SCOPE_REQUIRED');const reader=await resolveReader(library_id);need(hash(currentView(reader,library_id))===hash(view),'MEMORY_SEARCH_PIN_MISMATCH');}
 return Object.freeze({mode:'DIRECT_KNOWLEDGE',search,assertCurrent});
}
