/** Index saved Docling chunks without inventing offsets into serialized text. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';

export function createNativeHybridSourceRecords({snapshot,plan}) {
  need(snapshot?.snapshot_id&&Array.isArray(snapshot.documents)&&plan?.source_snapshot_ref===snapshot.snapshot_id&&
    plan.source_fingerprint===(snapshot.fingerprint??hash(snapshot)),'NATIVE_HYBRID_SOURCE_BINDING_CHANGED');
  const {plan_sha256,...body}=plan;
  need(plan_sha256===hash(body)&&plan.policy?.engine==='DoclingHybridChunker'&&Array.isArray(plan.chunks),'NATIVE_HYBRID_SOURCE_PLAN_CHANGED');
  const ids=new Set();
  return plan.chunks.map(chunk=>{
    const doc=snapshot.documents.find(d=>d.doc_id===chunk.doc_ref&&d.revision===chunk.revision);
    need(doc&&textField(chunk.chunk_ref)&&!ids.has(chunk.chunk_ref)&&Array.isArray(chunk.source_block_refs),'NATIVE_HYBRID_SOURCE_CHUNK_INVALID');
    ids.add(chunk.chunk_ref);
    const text=chunk.contextualized_text??chunk.text;
    need(textField(text)&&text.length<=128000,'NATIVE_HYBRID_SOURCE_TEXT_INVALID');
    const spans=[...new Set(chunk.source_block_refs)].map(ref=>{
      const block=doc.blocks.find(b=>b.block_id===ref);
      need(block&&Number.isSafeInteger(block.start)&&Number.isSafeInteger(block.end)&&block.start>=0&&block.end>block.start&&block.end<=doc.content.length,'NATIVE_HYBRID_SOURCE_BLOCK_INVALID');
      return {doc_ref:doc.doc_id,revision:doc.revision,block_id:block.block_id,start:block.start,end:block.end,
        quote:doc.content.slice(block.start,block.end),offset_unit:'utf16_code_unit',provenance:clone(block.provenance??[])};
    });
    // These are real original-block spans associated through Docling items.
    // They are deliberately not char offsets for the contextualized chunk.
    const evidence=spans.length?[{evidence_ref:'hybrid_source_evidence_'+hash([snapshot.snapshot_id,chunk.chunk_ref,spans]),
      source_chunk_ref:chunk.chunk_ref,doc_ref:doc.doc_id,revision:doc.revision,source_mapping:'DOCLING_ITEM_TO_ORIGINAL_BLOCK',
      mapping_precision:'BLOCK_ASSOCIATION_NOT_CHUNK_CHARACTER_ALIGNMENT',source_items:clone(chunk.source_items??[]),spans}]:[];
    need(evidence.length>0,'NATIVE_HYBRID_SOURCE_MAPPING_REQUIRED');
    return {record_ref:'hybrid_source_record_'+hash([snapshot.snapshot_id,plan.plan_ref,chunk.chunk_ref]),
      representation:'VERBATIM_SOURCE',source_text_representation:'DOCLING_CONTEXTUALIZED_SOURCE',answer_authority:'ORIGINAL_SOURCE',
      text,source_refs:[{doc_ref:doc.doc_id,revision:doc.revision}],source_chunk_ref:chunk.chunk_ref,source_plan_ref:plan.plan_ref,
      source_items:clone(chunk.source_items??[]),source_spans:spans.map(({quote,...span})=>span),evidence_refs:evidence.map(e=>e.evidence_ref),evidence,
      conditions:[],source_snapshot_ref:snapshot.snapshot_id,parser:clone(doc.parser??null),
      text_policy:{version:'native-hybrid-source-chunk/1',engine:plan.policy.engine,tokenizer:plan.policy.tokenizer,
        max_tokens:plan.policy.max_tokens,model_tokenizer_match:'NOT_ASSERTED',source_mapping:'DOCLING_ITEM_TO_ORIGINAL_BLOCK',exact_flat_text_offsets:false}};
  });
}
