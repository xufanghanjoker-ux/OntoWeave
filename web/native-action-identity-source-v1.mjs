/** Typed source reader around the existing IDENTITY stage. No source is relabelled. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {createNativeSourceReader} from './native-agent-read-session-v1.mjs';
import {LIBRARY_IDENTITY_TOOLS as I} from './native-library-knowledge-agent-v1.mjs';

export function withNativeActionIdentitySources({stage,profiles,record,readSource,assertCurrent}) {
  const sources = new Map(), readers = new Map();
  for (const ref of profiles.flatMap(profile => profile.source_refs ?? [])) {
    const memory = ref.kind === 'MEMORY_RECORD_SOURCE';
    const source_ref = memory ? ref.record_ref : ref.doc_ref;
    if (!textField(source_ref) || !textField(ref.revision)) continue;
    const typed = memory ? {kind:'MEMORY_RECORD_SOURCE',source_ref,revision:ref.revision,
      source_kind:ref.source_kind,document_evidence_eligible:false}
      : {kind:'DOCUMENT',source_ref,revision:ref.revision,document_evidence_eligible:true};
    sources.set(hash([typed.kind,source_ref,typed.revision]),typed);
  }
  const directory = [...sources.values()].map((source,index) => ({...source,document_ref:'L'+(index+1)}));
  function read(args) {
    assertCurrent();
    const source = directory.find(item => item.document_ref === args.document_ref);
    if (!source) return {warning:'LIBRARY_SOURCE_SELECTION_UNKNOWN',sources:clone(directory)};
    let reader = readers.get(source.document_ref);
    if (!reader) {
      const value = source.kind === 'MEMORY_RECORD_SOURCE' && source.source_ref === record.record_ref
        ? {kind:'MEMORY_RECORD_SOURCE',source_ref:record.record_ref,revision:String(record.version),
          text:record.text,source_kind:record.source.kind,document_evidence_eligible:false}
        : readSource?.({...clone(source),library_id:record.library_id});
      if (!value) return {warning:'LIBRARY_SOURCE_UNAVAILABLE',source:clone(source)};
      need(value.kind === source.kind && value.source_ref === source.source_ref
        && value.revision === source.revision && typeof value.text === 'string'
        && (value.library_id === undefined || value.library_id === record.library_id)
        && (source.source_kind === undefined || value.source_kind === source.source_kind)
        && (source.kind !== 'MEMORY_RECORD_SOURCE' || value.document_evidence_eligible === false),
      'ACTION_IDENTITY_SOURCE_BINDING_CHANGED');
      const sourceRefs = source.kind === 'DOCUMENT'
        ? [{kind:'DOCUMENT',doc_ref:source.source_ref,revision:source.revision}]
        : [{kind:'MEMORY_RECORD_SOURCE',record_ref:source.source_ref,revision:source.revision,
          source_kind:value.source_kind,document_evidence_eligible:false}];
      reader = createNativeSourceReader({text:value.text,sourceRefs});
      readers.set(source.document_ref,reader);
    }
    return {source:clone(source),...reader({contains:args.contains,continue:args.continue})};
  }
  const tools = {...stage.tools,
    definitions:stage.tools.definitions.map(tool => tool.name !== I.SOURCE ? tool : {...tool,
      description:'定向读取给定来源目录的原文。document_ref选择L项；kind明确区分DOCUMENT与MEMORY_RECORD_SOURCE。人工原话只证明记录了该说法。可用contains定位、continue:true续读。'}),
    progressSnapshot:context => context.name === I.SOURCE
      ? {sources:[...readers].map(([document_ref,reader]) => ({document_ref,...reader.progressSnapshot()}))}
      : stage.tools.progressSnapshot(context),
    async call(name,args={},ctx={}) {
      if (name !== I.SOURCE) return stage.tools.call(name,args,ctx);
      try {return {ok:true,result:read(args)};}
      catch (error) {return {ok:false,error:{code:error.code??'ACTION_IDENTITY_SOURCE_FAILED'}};}
    },
  };
  return {...stage,tools,prompt:stage.prompt+'\n定向原文使用以下有类型来源目录，不把原话当文档证据：\n'+JSON.stringify({typed_sources:directory}),
    source_directory:clone(directory)};
}
