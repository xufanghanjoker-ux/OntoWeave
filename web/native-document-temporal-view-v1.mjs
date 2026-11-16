/** Small business view over a frozen full binding; exact source remains on-demand. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
import {collectNativeDocumentTemporalContext} from './native-document-temporal-context-v1.mjs';
const list=value=>Array.isArray(value)?value:[];
const unique=rows=>[...new Map(rows.map(row=>[hash(row),row])).values()];
const brief=item=>Object.fromEntries(['text','statement','quote','participants','values','conditions','unit','negation','modality','time_text','temporal_hints']
  .filter(key=>item[key]!==undefined).map(key=>[key,clone(item[key])]));
const hintBrief=item=>Object.fromEntries(['time_text','statement','scope','quote','context_role','semantic_refs','unresolved_semantic_refs','statement_contexts','warnings']
  .filter(key=>item?.[key]!==undefined).map(key=>[key,clone(item[key])]));
export function createNativeDocumentTemporalView(input) {
  const documents=collectNativeDocumentTemporalContext(input),usedEvidence=new Set(),usedFacts=new Set(),usedSemantics=new Map();
  const incoming=input.incoming.map(row=>{
    const k=row.knowledge??{},lineage=k.semantic_lineage??{},linked=[];
    const hintLink=input.temporal_hint_links?.knowledge_links?.find(link=>link.knowledge_ref===row.ref);
    const linkedPackage=p=>p.package&&((lineage.package_ref&&p.package.package_ref===lineage.package_ref)
      ||list(lineage.package_refs).some(pin=>pin.package_ref===p.package.package_ref&&(!(pin.sha256??pin.record_sha256)||(pin.sha256??pin.record_sha256)===p.package.record_sha256)));
    for(const p of input.semantics)if(linkedPackage(p)) {
      const items=list(p.package.items).filter(item=>list(lineage.semantic_refs).includes(item.semantic_ref));
      linked.push(...items.map(item=>({package_ref:p.ref,semantic_ref:item.semantic_ref,...brief(item)})));
      const prior=usedSemantics.get(p.ref)??{ref:p.ref,items:[]};prior.items=unique([...prior.items,...items.map(item=>({semantic_ref:item.semantic_ref,...brief(item)}))]);usedSemantics.set(p.ref,prior);
    }
    const quotes=unique([...list(k.evidence).flatMap(e=>e.spans??[e]).map(e=>e.quote),...list(row.sources).map(s=>s.quote),...linked.map(s=>s.quote)].filter(Boolean));
    const evidence=input.evidence.filter(e=>list(row.evidence_refs).includes(e.ref)&&quotes.some(q=>e.quote.includes(q)||q.includes(e.quote))).map(e=>e.ref);
    evidence.forEach(ref=>usedEvidence.add(ref));
    const related=input.current.filter(f=>f.fact?.content?.subject_ref===row.content?.subject_ref&&f.fact?.content?.predicate===row.content?.predicate),candidates=related.slice(0,4);
    candidates.forEach(f=>usedFacts.add(f.ref));
    const docRefs=new Set(input.documents.filter(d=>list(k.source_refs).some(s=>s.doc_ref===d.doc_ref&&s.revision===d.revision)).map(d=>d.ref));
    const hints=unique([...(k.time_text!==undefined?[{time_text:clone(k.time_text),scope:'STATEMENT'}]:[]),
      ...list(k.temporal_hints),...linked.flatMap(s=>list(s.temporal_hints)),
      ...input.semantics.filter(linkedPackage).flatMap(p=>list(p.temporal_hints??p.package.temporal_hints)
        .filter(h=>list(h.semantic_refs).some(ref=>list(lineage.semantic_refs).includes(ref)))
        .map(h=>({...h,semantic_refs:list(h.semantic_refs).filter(ref=>list(lineage.semantic_refs).includes(ref)),
          ...(h.statement_contexts?{statement_contexts:list(h.statement_contexts).filter(s=>list(lineage.semantic_refs).includes(s.semantic_ref))}:{})})))].map(hintBrief));
    return {ref:row.ref,content:clone(row.content),statement:k.statement??k.text??null,
      subjects:list(k.domain?.entities).filter(e=>e.id===row.content?.subject_ref||e.id===k.object_ref).map(e=>({ref:e.id,name:e.name??e.label,kind:e.kind})),
      time_hints:hints,time_hint_status:hints.length?'CANDIDATES_REQUIRE_SCOPE_INTERPRETATION':'NOT_PROVIDED_NOT_TIMELESS',
      time_hint_link_warnings:clone(hintLink?.warnings??[]),unresolved_semantic_refs:clone(hintLink?.unresolved_semantic_refs??[]),
      semantic_refs:linked.map(s=>({package_ref:s.package_ref,semantic_ref:s.semantic_ref})),
      document_refs:[...docRefs],evidence_refs:evidence,current_refs:candidates.map(f=>f.ref),current_candidate_count:related.length,
      additional_current_refs:related.slice(4).map(f=>f.ref),source_available:true};
  });
  // Document context is shared once, with exact E navigation; never copied onto every K as an anchor.
  for(const doc of documents)for(const c of doc.context)for(const ref of c.evidence_refs)usedEvidence.add(ref);
  return {incoming,current:input.current.filter(f=>usedFacts.has(f.ref)).map(f=>({ref:f.ref,content:clone(f.fact.content),
      valid_time:clone(f.fact.valid_time),asserted_valid_time:clone(f.fact.asserted_valid_time),
      source_quotes:list(f.source_records).map(s=>s.quote).filter(Boolean),source_available:true})),
    semantics:[...usedSemantics.values()],documents,evidence:input.evidence.filter(e=>usedEvidence.has(e.ref)).map(e=>({ref:e.ref,document_ref:e.document_ref,quote:e.quote,source_available:true})),
    constraints:input.constraints.filter(c=>incoming.some(k=>k.content?.predicate===c.definition?.name)).map(c=>({ref:c.ref,definition:clone(c.definition)}))};
}
