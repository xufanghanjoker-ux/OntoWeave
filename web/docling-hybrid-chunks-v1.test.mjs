import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDoclingHybridChunkPlan} from './docling-hybrid-chunks-v1.mjs';
import {assembleDocument} from './documents.mjs';
import {hash} from './cq-discovery-store-v2.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const python=resolve(ROOT,'.venv-docling312/bin/python');
const sha=value=>createHash('sha256').update(value).digest('hex');
const tokenizerCache=process.env.TIKTOKEN_CACHE_DIR ?? resolve(ROOT,'.ontoweave/docling-models/tiktoken');
const tokenizerEnv={...process.env,TIKTOKEN_CACHE_DIR:tokenizerCache};
const available=spawnSync(python,['-c','import tiktoken,semchunk; from docling_core.transforms.chunker.hybrid_chunker import HybridChunker'],{stdio:'ignore'}).status===0;
const cached=existsSync(resolve(tokenizerCache,'9b5ad71b2ce5302211f9c61530b329a4922fc6a4'));
const options={skip:(!available||!cached)&&'Run npm run setup:parser to prepare Docling and the tokenizer cache'};
const fixtureCode=String.raw`
import json,sys
from docling_core.types.doc import DoclingDocument,DocItemLabel,TableData,TableCell
from docling_core.types.doc import ProvenanceItem,BoundingBox,CoordOrigin
d=DoclingDocument(name="Hybrid synthetic fixture")
d.add_title("结构分块测试")
d.add_heading("规则与对象",level=1)
d.add_text(label=DocItemLabel.TEXT,text=("中文规则保留适用对象、状态和例外。"*1800 if sys.argv[1]=="long" else "只有已关闭且已确认的工单才能归档。"))
if sys.argv[1]=="headings":
    for index in range(6):
        d.add_heading(f"章节{index}",level=2)
        d.add_text(label=DocItemLabel.TEXT,text=f"本节独立规则{index}仅适用于已确认对象。")
if sys.argv[1] in ("table", "large-table", "wide-table"):
    nrows=481 if sys.argv[1]=="large-table" else 81
    ncols=20 if sys.argv[1]=="wide-table" else 2
    cells=[]
    for row in range(nrows):
        for col in range(ncols):
            text=("主体" if col==0 else "规则") if row==0 else (f"主体{row:03d}" if col==0 else f"必须保留条件{row:03d}及单位")
            if sys.argv[1]=="wide-table":text=f"Header{col:02d}" if row==0 else f"CELL{row:03d}C{col:02d}"
            cells.append(TableCell(text=text,start_row_offset_idx=row,end_row_offset_idx=row+1,start_col_offset_idx=col,end_col_offset_idx=col+1,column_header=row==0))
    caption=d.add_text(label=DocItemLabel.CAPTION,text="表格说明：2026年试点对象，单位小时。")
    table=d.add_table(data=TableData(table_cells=cells,num_rows=nrows,num_cols=ncols),prov=ProvenanceItem(page_no=2,bbox=BoundingBox(l=0,t=0,r=100,b=100,coord_origin=CoordOrigin.TOPLEFT),charspan=(0,1)))
    table.captions.append(caption.get_ref())
    footnote=d.add_text(label=DocItemLabel.FOOTNOTE,text="表格脚注：仅确认状态，缺失值不是零。")
    table.footnotes.append(footnote.get_ref())
d.add_text(label=DocItemLabel.TEXT,text="末尾标记：不得遗漏后续材料。")
blocks=[]
for item,_ in d.iterate_items():
    label=item.label.value
    text=item.export_to_markdown(doc=d) if label=="table" else getattr(item,"text","")
    if text.strip(): blocks.append({"block_id":item.self_ref,"kind":label,"text":text,"provenance":[p.model_dump(mode="json") for p in getattr(item,"prov",[])]})
print(json.dumps({"parser":"docling","blocks":blocks,"document":d.export_to_dict(),"warnings":[]},ensure_ascii=False))
`;

function fixture(mode='short'){
  const directory=mkdtempSync(join(tmpdir(),'hybrid-chunk-test-')),documentStorage=join(directory,'documents');
  const sourceId=randomUUID(),dir=join(documentStorage,sourceId);mkdirSync(dir,{recursive:true});
  const raw=JSON.parse(execFileSync(python,['-c',fixtureCode,mode],{encoding:'utf8',maxBuffer:8*1024*1024}));
  const original=Buffer.from('Synthetic Docling fixture; no OCR/model execution.\n'+JSON.stringify(raw.blocks));
  const parsed=assembleDocument(raw,{document_id:sourceId,title:'Synthetic fixture',extension:'.md',original_sha256:sha(original),created_at:'2026-11-07T00:00:00.000Z'});
  writeFileSync(join(dir,'docling.json'),JSON.stringify(raw));writeFileSync(join(dir,'parsed.json'),JSON.stringify(parsed));writeFileSync(join(dir,'original.md'),original);
  const snapshot={snapshot_id:'synthetic_snapshot_'+sourceId,documents:[{doc_id:'source_'+sourceId,revision:'revision_'+hash(parsed),title:parsed.title,content:parsed.content,blocks:parsed.blocks,
    parser:{name:'docling',document_id:sourceId,parsed_sha256:parsed.parsed_sha256,original_sha256:parsed.original_sha256}}]};
  return {directory,documentStorage,dir,snapshot,dispose:()=>rmSync(directory,{recursive:true,force:true})};
}

test('HybridChunker uses real cl100k tokens at 8000, including Chinese text far larger than 8KB',options,async()=>{
  const f=fixture('long');
  try{
    const plan=await createDoclingHybridChunkPlan({...f,maxTokens:8000,structureBlocks:false});
    assert.equal(plan.policy.engine,'DoclingHybridChunker');assert.equal(plan.policy.tokenizer,'cl100k_base');
    assert.equal(plan.policy.model_tokenizer_match,'NOT_ASSERTED');
    assert.ok(plan.chunks.length>1);assert.ok(plan.chunks.every(c=>c.token_count<=8000));
    assert.ok(plan.chunks.some(c=>Buffer.byteLength(c.contextualized_text,'utf8')>8000));
    assert.ok(plan.chunks.some(c=>c.text.includes('末尾标记')));
    assert.equal(plan.summary.represented_blocks,plan.summary.source_blocks);
    assert.equal(plan.gaps.length,0);assert.equal(plan.model_calls,0);
    const exact=JSON.parse(execFileSync(python,['-c','import json,sys,tiktoken; e=tiktoken.get_encoding("cl100k_base"); print(json.dumps([len(e.encode(t)) for t in json.load(sys.stdin)]))'],
      {input:JSON.stringify(plan.chunks.map(c=>c.contextualized_text)),encoding:'utf8',env:tokenizerEnv}));
    assert.deepEqual(plan.chunks.map(c=>c.token_count),exact);
    assert.ok(plan.chunks.every(c=>c.serialization_status==='DOCLING_RESERIALIZED_NOT_EXACT_FLAT_TEXT_SPANS'&&!Object.hasOwn(c,'start')));
    assert.ok(plan.windows.every(w=>w.token_count<=8000&&w.source_chunk_refs.length>0));
    assert.deepEqual(plan.windows.flatMap(w=>w.source_chunk_refs),plan.chunks.map(c=>c.chunk_ref));
  }finally{f.dispose();}
});

test('Docling long tables retain repeated headers, original item references and provenance',options,async()=>{
  const f=fixture('table');
  try{
    const plan=await createDoclingHybridChunkPlan({...f,maxTokens:128});
    const tableRef=f.snapshot.documents[0].blocks.find(b=>b.kind==='table').block_id;
    const chunks=plan.chunks.filter(c=>c.source_block_refs.includes(tableRef));
    assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.text.includes('主体')&&c.text.includes('规则')));
    assert.ok(chunks.every(c=>c.token_count<=128));
    assert.ok(chunks.every(c=>c.source_items.some(s=>s.self_ref===tableRef&&s.provenance.some(p=>p.page_no===2))));
    for(let row=1;row<=80;row++)assert.ok(chunks.some(c=>c.text.includes('主体'+String(row).padStart(3,'0'))),'row '+row+' retained');
    assert.equal(plan.coverage.find(c=>c.block_id===tableRef).status,'REPRESENTED_BY_SOURCE_ITEMS');
    assert.deepEqual(plan.windows.flatMap(w=>w.source_chunk_refs),plan.chunks.map(c=>c.chunk_ref));
  }finally{f.dispose();}
});

test('frozen source and tokenizer policy produce stable chunks, changed source cannot reuse them',options,async()=>{
  const f=fixture();
  try{
    const first=await createDoclingHybridChunkPlan({...f,outputDirectory:join(f.directory,'out')});
    const second=await createDoclingHybridChunkPlan({...f,outputDirectory:join(f.directory,'out')});
    assert.deepEqual(first,second);
    const alternate=await createDoclingHybridChunkPlan({...f,maxTokens:256});
    assert.notEqual(first.plan_ref,alternate.plan_ref);
    const changed=structuredClone(f.snapshot);changed.documents[0].content+='被修改';
    await assert.rejects(createDoclingHybridChunkPlan({...f,snapshot:changed}),{code:'HYBRID_CHUNK_SOURCE_MISMATCH'});
    writeFileSync(join(f.dir,'original.md'),'changed original');
    await assert.rejects(createDoclingHybridChunkPlan(f),{code:'HYBRID_CHUNK_ORIGINAL_SOURCE_CHANGED'});
    assert.equal(JSON.parse(readFileSync(join(f.directory,'out','hybrid-chunk-plan.json'),'utf8')).plan_ref,first.plan_ref);
  }finally{f.dispose();}
});

test('CQ windows compose complete adjacent native chunks without mixing source documents or dropping headings',options,async()=>{
  const first=fixture('headings'),second=fixture('headings');
  try{
    cpSync(second.dir,join(first.documentStorage,second.snapshot.documents[0].parser.document_id),{recursive:true});
    first.snapshot.documents.push(second.snapshot.documents[0]);
    const plan=await createDoclingHybridChunkPlan({...first,structureBlocks:false});
    assert.ok(plan.chunks.length>plan.windows.length);assert.equal(plan.windows.length,2);
    assert.deepEqual(plan.windows.flatMap(w=>w.source_chunk_refs),plan.chunks.map(c=>c.chunk_ref));
    for(const window of plan.windows){
      const children=window.source_chunk_refs.map(ref=>plan.chunks.find(c=>c.chunk_ref===ref));
      assert.ok(children.every(c=>c.doc_ref===window.doc_ref&&c.revision===window.revision));
      assert.equal(window.contextualized_text,children.map(c=>c.contextualized_text).join('\n\n'));
      assert.equal(window.chunk_ref,window.window_ref);
      for(let index=0;index<6;index++)assert.ok(window.text.includes('章节'+index));
    }
  }finally{first.dispose();second.dispose();}
});

test('structure v2 emits one block per short document with unique frozen unit identities and no repacking',options,async()=>{
 const f=fixture('headings'),g=fixture('headings');
 try{
  cpSync(g.dir,join(f.documentStorage,g.snapshot.documents[0].parser.document_id),{recursive:true});f.snapshot.documents.push(g.snapshot.documents[0]);
  const p=await createDoclingHybridChunkPlan(f);
  assert.equal(p.version,'docling-structure-blocks/2');assert.equal(p.policy.max_tokens,5000);assert.equal(p.windows.length,2);assert.equal(p.chunks.length,2);assert.equal(p.gaps.length,0);
  assert.equal(new Set(p.windows.flatMap(w=>w.units.map(u=>u.unit_ref))).size,p.windows.flatMap(w=>w.units).length);
  for(const w of p.windows){assert.equal(w.units[0].label,'U001');const doc=f.snapshot.documents.find(d=>d.doc_id===w.doc_ref);
   assert.deepEqual(w.units.map(u=>u.text),doc.blocks.map(b=>doc.content.slice(b.start,b.end)));
   assert(w.units.some(u=>u.context.includes('章节5')));assert(w.token_count<=5000);
  }
 }finally{f.dispose();g.dispose();}
});

test('structure v2 exact serialized 5000 boundary and 5001 split with complete core text',options,()=>{
 const result=execFileSync(python,['-c',String.raw`
import sys,json,tiktoken
sys.path.insert(0,'web')
from docling_structure_blocks_v2 import build_structure_blocks
from docling_core.types.doc import DoclingDocument,DocItemLabel
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
e=tiktoken.get_encoding('cl100k_base'); tok=OpenAITokenizer(tokenizer=e,max_tokens=5000); h=HybridChunker(tokenizer=tok)
results=[]
for target in (5000,5001):
 n=target-len(e.encode('[U001] '))
 text=' a'*n
 while len(e.encode('[U001] '+text))<target:text+=' a'
 assert len(e.encode('[U001] '+text))==target
 d=DoclingDocument(name='boundary');i=d.add_text(label=DocItemLabel.TEXT,text=text)
 raw={'blocks':[{'block_id':i.self_ref,'text':text}]}
 chunks=build_structure_blocks(d,raw,e,5000,h,lambda i,r:{'self_ref':i.self_ref,'role':r})
 assert all(c['status']=='PLANNED' and c['token_count']<=5000 for c in chunks)
 assert ''.join(u['text'] for c in chunks for u in c['units']).replace(' ','')==text.replace(' ','')
 results.append({'target':target,'blocks':len(chunks),'tokens':[c['token_count'] for c in chunks]})
print(json.dumps(results))
`],{cwd:ROOT,encoding:'utf8',env:tokenizerEnv});
 const rows=JSON.parse(result);assert.equal(rows[0].blocks,1);assert.equal(rows[0].tokens[0],5000);assert(rows[1].blocks>1);
});

test('structure v2 long paragraph fragments preserve all characters and source order',options,async()=>{
 const f=fixture('long');try{const p=await createDoclingHybridChunkPlan(f);assert.equal(p.gaps.length,0);assert(p.windows.length>1);
 for(const b of f.snapshot.documents[0].blocks){const text=p.windows.flatMap(w=>w.units).filter(u=>u.block_id===b.block_id).map(u=>u.text).join('');
  assert.equal(text.replace(/\s/gu,''),f.snapshot.documents[0].content.slice(b.start,b.end).replace(/\s/gu,''));}
 assert(p.windows.every(w=>w.token_count<=5000));}finally{f.dispose();}
});

test('offline composition: retained Docling -> processing blocks -> CQ save -> frozen range readback',options,async()=>{
 const {createRecordStore}=await import('../tests/fixtures/record-store.mjs'),{createNativeFullRun}=await import('./native-full-run-v1.mjs');
 const {runNativeChunkedCQ,readNativeCQMaterials}=await import('./native-chunked-cq-v1.mjs');
 const f=fixture('headings'),store=createRecordStore();
 try{const plan=await createDoclingHybridChunkPlan(f),runId='offline-composition',parent=createNativeFullRun({store,runId,input:{},limits:{max_generation_requests:1,max_wall_ms:60000}});let calls=0;
 const result=await runNativeChunkedCQ({store,catalog:{get:()=>f.snapshot,isCurrent:()=>true},libraryId:'offline',snapshotId:f.snapshot.snapshot_id,runId,parentRun:parent,plan,runtimeDirectory:join(f.directory,'runtime'),skillPaths:[],upstream:()=>assert.fail('offline only'),
  agentRunner:async args=>{calls++;const req=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});args.run.settle(req.request_ref,{outcome:'RETURNED'});
   const c=plan.windows.find(c=>c.chunk_ref===args.agentScope),label=c.units.find(u=>u.text.includes('本节独立规则3')).label;
   await args.tools.call('lightog_save_cq_list',{items:[{question:'规则3适用于什么对象？',ranges:[{start:label,end:label}]}]});return {receipt:{status:'SUCCEEDED',outcome:'RETURNED'}};
  }});
 assert.equal(calls,1);assert.equal(result.scan_status,'COMPLETE');const read=readNativeCQMaterials({store,runId,cqRef:result.cq_input.items[0].cq_ref});assert.equal(read.units.length,1);assert(read.text.includes('本节独立规则3'));assert(read.text.includes('章节3'));
 }finally{f.dispose();}
});

for(const mode of ['large-table','wide-table'])test('structure v2 '+mode+' preserves every cell, row identity, caption and footnote under 5000',options,async()=>{
 const f=fixture(mode);try{const p=await createDoclingHybridChunkPlan(f);assert.equal(p.gaps.length,0);assert(p.windows.length>1);
 const table=f.snapshot.documents[0].blocks.find(b=>b.kind==='table'),units=p.windows.flatMap(w=>w.units).filter(u=>u.block_id===table.block_id);
 assert(units.length>1);assert(units.every(u=>u.context.includes('2026年试点对象，单位小时')&&u.context.includes('缺失值不是零')&&u.text.includes('row ')));
 if(mode==='large-table')for(let row=1;row<=480;row++)assert(units.some(u=>u.text.includes('主体'+String(row).padStart(3,'0'))),'row '+row);
 else for(let row=1;row<=80;row++)for(let col=0;col<20;col++)assert(units.some(u=>u.text.includes('CELL'+String(row).padStart(3,'0')+'C'+String(col).padStart(2,'0'))),'cell '+row+'/'+col);
 assert(p.windows.every(w=>w.token_count<=5000));
 const tokens=JSON.parse(execFileSync(python,['-c','import sys,json,tiktoken;e=tiktoken.get_encoding("cl100k_base");print(json.dumps([len(e.encode(t)) for t in json.load(sys.stdin)]))'],{input:JSON.stringify(p.windows.map(w=>w.text)),encoding:'utf8',env:tokenizerEnv}));assert.deepEqual(tokens,p.windows.map(w=>w.token_count));
 }finally{f.dispose();}
});

test('unfit heading context is retained as explicit gap with its original text, never silently stripped',options,()=>{
 const result=JSON.parse(execFileSync(python,['-c',String.raw`
import sys,json,tiktoken
sys.path.insert(0,'web')
from docling_structure_blocks_v2 import build_structure_blocks
from docling_core.types.doc import DoclingDocument,DocItemLabel
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
e=tiktoken.get_encoding('cl100k_base');d=DoclingDocument(name='context-gap');h=d.add_heading('长标题'*6000,level=1);i=d.add_text(label=DocItemLabel.TEXT,text='不可丢弃的原文与条件。')
raw={'blocks':[{'block_id':h.self_ref,'text':h.text},{'block_id':i.self_ref,'text':i.text}]}
c=build_structure_blocks(d,raw,e,5000,HybridChunker(tokenizer=OpenAITokenizer(tokenizer=e,max_tokens=5000)),lambda i,r:{'self_ref':i.self_ref,'role':r})
print(json.dumps({'gaps':[x for x in c if x['status']=='GAP'],'ok':[x['token_count'] for x in c if x['status']=='PLANNED']}))
`],{cwd:ROOT,encoding:'utf8',env:tokenizerEnv}));
 assert(result.gaps.some(g=>g.text==='不可丢弃的原文与条件。'));assert(result.ok.every(n=>n<=5000));
});
