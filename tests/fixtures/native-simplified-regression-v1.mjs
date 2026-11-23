import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRecordStore} from './record-store.mjs';
import {createDocumentCatalog} from '../../web/document-catalog-v1.mjs';
import {createNativeFullRun} from '../../web/native-full-run-v1.mjs';
import {createNativeExtractionWindowPlan} from '../../web/native-extraction-window-plan-v1.mjs';
import {PROGRESS_EXECUTION} from '../../web/native-execution-controls-v1.mjs';
import {SIMPLIFIED_SOURCE_POLICY} from '../../web/native-simplified-extraction-v1.mjs';
import {GENERAL_KNOWLEDGE_POLICY} from '../../web/native-general-knowledge-v1.mjs';

export function simplifiedFixture(t,n=1,{contents=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'simplified-regression-')),store=createRecordStore();
 const catalog=createDocumentCatalog({store,loadLibrary:()=>({source_epoch:1,sources:Array.from({length:n},(_,i)=>({id:'doc'+i,title:'资料'+i,content:contents?.[i]??'设备甲包含乙，仅低温时使用。额定功率20W。'}))})});
 const snapshot=catalog.freeze('lib',1),cqInput={input_ref:'cq',items:[]},families={input_ref:'cq',families:[]};
 const manifest=createNativeExtractionWindowPlan({snapshot,cqInput,families,windowTokens:8000});
 const parentRun=createNativeFullRun({store,runId:'regression-run',input:{build_flow_policy:SIMPLIFIED_SOURCE_POLICY,general_knowledge_policy:GENERAL_KNOWLEDGE_POLICY,execution_policy:PROGRESS_EXECUTION,extraction_window_policy:{version:'WINDOWED_EXTRACTION_V1',concurrency:4}}});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,store,catalog,snapshot,libraryId:'lib',snapshotId:snapshot.snapshot_id,parentRun,manifest,cqInput,families,runtimeDirectory:dir};
}
