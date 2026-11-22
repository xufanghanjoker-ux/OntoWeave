"""Authenticate final business messages against archived native wires and turns."""
import json
from ontoweave_cq.store import sha,require
from ontoweave_front_half.tool_execution import FixedMaterialRead

def events(raw):
    values=[]
    for frame in raw.split('\n\n'):
        data='\n'.join(line[5:].lstrip() for line in frame.splitlines() if line.startswith('data:'))
        if data and data!='[DONE]':values.append(json.loads(data))
    return values

def business_messages(raw,known=False):
    es=events(raw.replace('\r\n','\n'));out=[]
    terminal=[e for e in es if e.get('type')==('response.incomplete' if known else 'response.completed')]
    if len(terminal)!=1:return []
    response=terminal[0].get('response',{})
    if known and (response.get('status')!='incomplete' or response.get('incomplete_details',{}).get('reason') not in ('max_output_tokens','length')):return []
    for i,item in enumerate(response.get('output',[])):
        if item.get('type')!='message' or item.get('role')!='assistant' or item.get('phase') not in (None,'final_answer'):continue
        if item.get('status')!='completed':continue
        content=item.get('content',[])
        if any(p.get('type')!='output_text' for p in content):continue
        out.append(dict(message_id=item.get('id'),message_index=i,text=''.join(p['text'] for p in content)))
    return out

class ExtractionTools:
    definitions=[dict(name='extraction_read_task',description='读取本任务已经提供的材料。无保存或finish工具。',inputSchema=dict(type='object',properties={},additionalProperties=False),annotations=dict(readOnlyHint=True,destructiveHint=False,openWorldHint=False,idempotentHint=True))]
    def __init__(self,repo,run,reception,task):self.repo,self.run,self.reception,self.task=repo,run,reception,task;self.complete=False;self.seen=set();self.last=None;self.database_unknown=False;self.material_reader=FixedMaterialRead();self.reception_has_output=False;self.saved_business=False
    def is_complete(self):return self.complete
    def call(self,name,args,context=None):
        if name=='extraction_read_task':return self.material_reader.call(args,lambda:self.task['material'])
        require(name=='__program_finalize_turn','EXTRACTION_TOOL_FORBIDDEN');return self.finalize(args)
    def finalize(self,context):
        native=context['native_completion'];require(native['status']=='completed','NATIVE_NOT_COMPLETED')
        bound_events=[r['payload'] for r in self.repo.list_rows() if r['kind']=='native_agent_event_v1' and r['payload'].get('invocation_ref')==context['invocation_ref']]
        require(any(e.get('type')=='RUNTIME_NOTIFICATION' and e.get('notification',{}).get('method')=='turn/completed' and e['notification'].get('params',{}).get('threadId')==native['thread_id'] and e['notification'].get('params',{}).get('turn',{}).get('id')==native['turn_id'] and e['notification']['params']['turn'].get('status')=='completed' and not e['notification']['params']['turn'].get('error') for e in bound_events),'NATIVE_COMPLETION_UNBOUND')
        refs=context['request_refs'];ledger=self.run.state();attempts={a['request_ref']:a for a in ledger['attempts']}
        for ref in refs:
            require(ref in attempts and attempts[ref]['outcome']=='RETURNED','REQUEST_NOT_CONFIRMED')
            wire=self.repo.get_record('native_agent_wire_v1',ref);response=self.repo.get_record('native_agent_response_v1',ref)
            require(wire and response and wire['agent_scope']==self.task['task_ref'] and wire['invocation_ref']==context['invocation_ref']==response['invocation_ref'],'NATIVE_OWNER_MISMATCH')
            require(response.get('complete_body') and not response.get('redacted') and not response.get('redaction_error') and sha(response['body_utf8'])==response['body_sha256'],'NATIVE_RAW_UNAUTHENTICATED')
            if ref in self.seen:continue
            messages=business_messages(response['body_utf8'])
            messages=[m for m in messages if m['text'].strip()]
            for m in messages:
                identity=dict(request_ref=ref,thread_id=native['thread_id'],turn_id=native['turn_id'],message_id=m['message_id'],message_index=m['message_index'],invocation_ref=context['invocation_ref'])
                delivery=dict(outcome='RETURNED',transport_complete=True,native_completion=native,identity_verified=True)
                rr=self.reception.archive(self.task['task_ref'],identity,m['text'].encode(),delivery)
                receipt=self.reception.receive(rr)
                self.reception_has_output=True
                self.saved_business|=bool(receipt['candidate_refs'] or receipt['legal_no_knowledge']
                                          or any(i.get('mention_ref') for i in receipt['items']))
            self.seen.add(ref)
        if not self.seen or not self.reception_has_output:
            return dict(complete=False)
        self.last=self.reception.settle_task(self.task['task_ref'],final=self.saved_business or context.get('continuation_exhausted',False))
        status=self.last.get('execution_status',self.last['status']);self.complete=status in ('COMPLETED','NO_CANDIDATES')
        if self.complete:return dict(complete=True,saved_output=True,status=status,content_counts=self.last.get('content_counts'),alignment_revision_ref=None)
        if self.last['continue_eligible']:return dict(complete=False,saved_output=True)
        return dict(partial=True,saved_output=True,status=status,reason='EXTRACTION_RECEPTION_GAPS')
    def salvage(self,result):
        # No reissue. Explicit provider length terminal can certify completed messages,
        # even though the older SSE gate classified that request as FAILED.
        ledger=self.run.state();saw_unknown=self.database_unknown
        for attempt in ledger['attempts']:
            ref=attempt['request_ref']
            if ref in self.seen:continue
            wire=self.repo.get_record('native_agent_wire_v1',ref);response=self.repo.get_record('native_agent_response_v1',ref)
            matches=wire and response and wire.get('agent_scope')==self.task['task_ref'] and wire.get('invocation_ref')==response.get('invocation_ref')
            authenticated=bool(matches and response.get('complete_body') and not response.get('redacted') and not response.get('redaction_error') and sha(response.get('body_utf8',''))==response.get('body_sha256'))
            known=[];known_terminal=False
            if authenticated:
                try:
                    es=events(response['body_utf8'].replace('\r\n','\n'))
                    ends=[e for e in es if e.get('type') in ('response.completed','response.incomplete','response.failed','error')]
                    known_terminal=len(ends)==1 and es[-1]==ends[0] and ends[0].get('type')=='response.incomplete' and ends[0].get('response',{}).get('status')=='incomplete' and ends[0].get('response',{}).get('incomplete_details',{}).get('reason') in ('max_output_tokens','length')
                    known=business_messages(response['body_utf8'],known=True) if known_terminal else []
                except (ValueError,KeyError):pass
            outcome='KNOWN_INCOMPLETE' if known_terminal else 'UNKNOWN' if attempt['outcome'] in ('UNKNOWN','RESERVED') else 'FAILED'
            saw_unknown|=outcome=='UNKNOWN'
            if known:
                for m in known:
                    identity=dict(request_ref=ref,thread_id=result.get('receipt',{}).get('thread_id'),turn_id=result.get('receipt',{}).get('turn_id'),message_id=m['message_id'],message_index=m['message_index'])
                    delivery=dict(outcome=outcome,transport_complete=False,explicit_terminal=True,identity_verified=True,certified_complete_message=True,raw_authenticated=True)
                    rr=self.reception.archive(self.task['task_ref'],identity,m['text'].encode(),delivery);self.reception.receive(rr)
            else:
                identity=dict(request_ref=ref,thread_id=result.get('receipt',{}).get('thread_id'),turn_id=result.get('receipt',{}).get('turn_id'),message_index=-1)
                # Preserve raw transport bytes for UNKNOWN; never pass them to parser.
                raw=(response or {}).get('body_utf8','').encode();rr=self.reception.archive(self.task['task_ref'],identity,raw,dict(outcome=outcome,transport_complete=False,identity_verified=bool(matches),no_business_blob=not bool(response),explicit_terminal=known_terminal,raw_authenticated=authenticated,certified_complete_message=False));self.reception.receive(rr)
        return self.reception.settle_task(self.task['task_ref'],final=True,force='UNKNOWN_HOLD' if saw_unknown else None)
