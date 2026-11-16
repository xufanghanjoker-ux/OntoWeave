/** Navigation frames contain reading state; transient hover/selection replaces a frame. */
const memoryRef = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function memoryFrame(frame, enabled) {
 const copy=structuredClone(frame);
 if(enabled===true&&copy.memory_mode==='records')copy.memory_record_ref=memoryRef(copy.memory_record_ref)?copy.memory_record_ref:null;
 else {if(Object.hasOwn(copy,'memory_mode'))copy.memory_mode=null;if(Object.hasOwn(copy,'memory_record_ref'))copy.memory_record_ref=null;}
 return copy;
}
export function createLightogNavigation({history,location,initial,onNavigate=()=>{},memoryEnabled=false}){
 let current=memoryFrame(initial,memoryEnabled),serial=0,currentKey=null;
 const frames=new Map();
 const memoryUrl=frame=>memoryEnabled===true&&frame.memory_mode==='records'?'&memory=records'+(memoryRef(frame.memory_record_ref)?'&memory_record='+encodeURIComponent(frame.memory_record_ref):''):'';
 const queryUrl=frame=>(frame.conversation_id?'&conversation='+encodeURIComponent(frame.conversation_id):'')+(frame.chat_turn_id?'&turn='+encodeURIComponent(frame.chat_turn_id):'')+(frame.query_ref?'&query='+encodeURIComponent(frame.query_ref)+(frame.query_citation_ref?'&cite='+encodeURIComponent(frame.query_citation_ref)+'&cite_source='+(frame.query_source_index??0):''):'')+memoryUrl(frame);
 const url=frame=>'#library='+encodeURIComponent(frame.library_id??'')+'&view='+encodeURIComponent(frame.page??'graph')+(frame.document_key?'&document='+encodeURIComponent(frame.document_key):'')+(frame.knowledge_id?'&knowledge='+encodeURIComponent(frame.knowledge_id):'')+(frame.definition_id?'&definition='+encodeURIComponent(frame.definition_id):'')+(frame.block_id?'&block='+encodeURIComponent(frame.block_id):'')+(Number.isInteger(frame.source_index)?'&source='+frame.source_index:'')+(frame.source_filter?'&filter='+encodeURIComponent(frame.source_filter):'')+(frame.object_id?'&object='+encodeURIComponent(frame.object_id):'')+(frame.display==='list'?'&display=list':'')+(frame.search?'&q='+encodeURIComponent(frame.search):'')+(frame.ontology_kind?'&kind='+encodeURIComponent(frame.ontology_kind):'')+(frame.sources_open?'&evidence=1':'')+(frame.ontology_scope?'&formation='+encodeURIComponent(frame.ontology_scope):'')+(frame.pending_item_id?'&item='+encodeURIComponent(frame.pending_item_id):'')+(frame.evidence_kind?'&source_kind='+encodeURIComponent(frame.evidence_kind)+'&source_owner='+encodeURIComponent(frame.evidence_id??'')+'&source_n='+encodeURIComponent(frame.evidence_index??0)+(Number.isInteger(frame.evidence_mention)?'&mention='+frame.evidence_mention:''):'');
 function write(push){const key='lightog-'+(++serial);currentKey=key;frames.set(key,structuredClone(current));history[push?'pushState':'replaceState']({lightog:key},'',url(current)+queryUrl(current));}
 write(false);
 return {
  current:()=>structuredClone(current),
  update(patch){current=memoryFrame({...current,...structuredClone(patch)},memoryEnabled);if(currentKey){frames.set(currentKey,structuredClone(current));if(history.state?.lightog===currentKey)history.replaceState({lightog:currentKey},'',url(current)+queryUrl(current));}else write(false);},
  replace(frame){current=memoryFrame(frame,memoryEnabled);frames.set(currentKey,structuredClone(current));history.replaceState({lightog:currentKey},'',url(current)+queryUrl(current));},
  go(next){this.update({});current={...memoryFrame(next,memoryEnabled),return_to:structuredClone(current)};write(true);return onNavigate(this.current());},
  back(){if(current.return_to){history.back();return true;}return false;},
  pop(event){const frame=frames.get(event.state?.lightog);if(frame){currentKey=event.state.lightog;current=structuredClone(frame);onNavigate(this.current());return true;}return false;},
  hasReturn:()=>Boolean(current.return_to),
  href:frame=>url(frame)+queryUrl(frame)
 };
}

export function parseLightogLink(hash,{memoryEnabled=false}={}){
 const p=new URLSearchParams(String(hash??'').replace(/^#/,'')),page=p.get('view');
 return {library_id:p.get('library')||null,page:['graph','sources','reader','ontology','pending','query','settings','libraries','upload'].includes(page)?page:'graph',document_key:p.get('document')||null,knowledge_id:p.get('knowledge')||null,definition_id:p.get('definition')||null,block_id:p.get('block')||null,source_index:/^\d{1,4}$/.test(p.get('source')??'')?Number(p.get('source')):null,source_filter:p.get('filter')||null,object_id:p.get('object')||null,display:p.get('display')==='list'?'list':'canvas',search:p.get('q')||'',ontology_kind:p.get('kind')||null,ontology_scope:['usable','pending','observations','rejected'].includes(p.get('formation'))?p.get('formation'):null,pending_item_id:p.get('item')||null,evidence_kind:['definition','mention','issue','identity-decision','pending-classified'].includes(p.get('source_kind'))?p.get('source_kind'):null,evidence_id:p.get('source_owner')||null,evidence_index:/^\d{1,4}$/.test(p.get('source_n')??'')?Number(p.get('source_n')):null,evidence_mention:/^\d{1,4}$/.test(p.get('mention')??'')?Number(p.get('mention')):null,sources_open:p.get('evidence')==='1',scroll_to_block:page==='reader'&&Boolean(p.get('block')||p.get('knowledge')),query_ref:/^[A-Za-z0-9_-]{1,160}$/.test(p.get('query')??'')?p.get('query'):null,query_citation_ref:/^[A-Za-z0-9_-]{1,256}$/.test(p.get('cite')??'')?p.get('cite'):null,query_source_index:/^\d{1,4}$/.test(p.get('cite_source')??'')?Number(p.get('cite_source')):0,conversation_id:/^[A-Za-z0-9_-]{1,160}$/.test(p.get('conversation')??'')?p.get('conversation'):null,chat_turn_id:/^[A-Za-z0-9_-]{1,160}$/.test(p.get('turn')??'')?p.get('turn'):null,memory_mode:memoryEnabled===true&&p.get('memory')==='records'?'records':null,memory_record_ref:memoryEnabled===true&&p.get('memory')==='records'&&memoryRef(p.get('memory_record'))?p.get('memory_record'):null};
}
