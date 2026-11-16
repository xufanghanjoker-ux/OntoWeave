/** Qualified graph Host adapter. Deterministic navigation runs in Rust v1. */
import {need} from './cq-discovery-store-v2.mjs';
import {createNativeQueryPager,nativeQueryScope} from './native-query-view-v1.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';

// Result projection after paging; graph selection and traversal execute in Rust.
function evidence(rows){return [...new Map(rows.flatMap(f=>f.evidence??[]).map(e=>[e.evidence_ref,e])).values()];}

export function createNativeQueryGraph({reader,execution={}}={}){
  need(reader&&['assertCurrent','scope','facts','subjects'].every(k=>typeof reader[k]==='function'),'NATIVE_QUERY_READER_INVALID');
  const paginate=createNativeQueryPager({reader,namespace:'graph-v1'});
  function execute(operation,args){
    reader.assertCurrent();
    return nativeQueryCore(operation,{facts:reader.facts(),subjects:reader.subjects(),args,execution});
  }
  const unavailable=()=>({status:'UNAVAILABLE_CAPABILITY',items:[],evidence:[],next_cursor:null,truncated:false,scope:nativeQueryScope(reader),semantic_entailment:false});
  function finish(core,args,paths=false){
    if(core.unavailable)return unavailable();
    const page=paginate(core.items,args,core.binding);
    if(paths)return {...page,status:core.metadata.search_truncated?'PARTIAL':page.status,truncated:page.truncated||core.metadata.search_truncated,...core.metadata,evidence:evidence(page.items.flatMap(path=>path.steps.map(step=>step.fact))),semantic_entailment:false};
    return {...page,evidence:evidence(page.items),semantic_entailment:false,...core.metadata};
  }
  return Object.freeze({
    getEntityFacts(args={}){return finish(execute('graph_entity_facts',args),args);},
    expandGraph(args={}){return finish(execute('graph_expand',args),args);},
    findPaths(args={}){return finish(execute('graph_paths',args),args,true);}
  });
}
