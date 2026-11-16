import {projectCurrentKnowledgeLineage} from './native-current-lineage-projection-v1.mjs';
import {currentKnowledge} from './native-general-knowledge-v1.mjs';
/** Project changed records only; retain other graph contributions and original sources. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
import {createDomainGraph} from './native-domain-knowledge-v1.mjs';
import {qualifyExtractedGraphDetails} from './native-query-extracted-reader-v1.mjs';
const unique=rows=>[...new Map(rows.map(row=>[hash(row),row])).values()];
export const projectNativeSimplifiedCurrentKnowledge=rows=>projectCurrentKnowledgeLineage(currentKnowledge(rows.filter(row=>!['NOT_ADOPTED','SUPERSEDED'].includes(row.assertion_status))));
export const effectiveNativeSimplifiedKnowledge=rows=>projectNativeSimplifiedCurrentKnowledge(rows).knowledge;
export function projectNativeSimplifiedGraphDelta({baseGraph=null,knowledge,affectedRefs}){
 const affected=new Set(affectedRefs);for(const row of knowledge.filter(row=>affected.has(row.record_ref??row.knowledge_ref)))for(const id of row.supersedes??[])affected.add(id);const effective=effectiveNativeSimplifiedKnowledge(knowledge);
 // Lineage changes can replace an unmodified source slot too. Reproject all
 // record contributions when temporal versions participate; keep saved metadata.
 if(knowledge.some(row=>row.temporal_fact)){for(const row of [...(baseGraph?.knowledge??[]),...knowledge])affected.add(row.knowledge_ref??row.record_ref);}
 const retained=baseGraph?qualifyExtractedGraphDetails(baseGraph,affected):{nodes:[],edges:[],definitions:[]};
 const delta=createDomainGraph(effective.filter(row=>affected.has(row.record_ref??row.knowledge_ref))),result={...clone(retained),semantic_policy:delta.semantic_policy,knowledge:clone(effective)};
 for(const key of ['nodes','edges','definitions']){const byId=new Map((retained[key]??[]).map(row=>[row.id,clone(row)]));for(const row of delta[key]??[]){const old=byId.get(row.id);if(!old){byId.set(row.id,{...clone(row),...(key==='definitions'&&!row.status?{status:'PENDING'}:{})});continue;}const merged={...old,...clone(row)};for(const field of ['record_refs','knowledge_refs'])if(old[field]||row[field])merged[field]=[...new Set([...(old[field]??[]),...(row[field]??[])])];for(const field of ['source_refs','attributes','rules'])if(old[field]||row[field])merged[field]=unique([...(old[field]??[]),...(row[field]??[])]);byId.set(row.id,merged);}result[key]=[...byId.values()];}
 return {graph:result,graph_delta:{changed_knowledge_refs:[...affected],removed_contribution_refs:[...affected],nodes:delta.nodes,edges:delta.edges,definitions:delta.definitions},projected_record_refs:effective.filter(row=>affected.has(row.record_ref??row.knowledge_ref)).map(row=>row.record_ref??row.knowledge_ref)};
}
