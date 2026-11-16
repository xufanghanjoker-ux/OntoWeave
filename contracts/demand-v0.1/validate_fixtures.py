#!/usr/bin/env python3
"""Read-only specification checks. Not a product compiler, query executor or LLM evaluation."""
from pathlib import Path
from datetime import date
import copy
import hashlib
import json
import re
from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
FIXTURES=ROOT/'fixtures/demand-contract-v0.1'
SAFE=9007199254740991
class Violation(ValueError):
    def __init__(self,code): super().__init__(code); self.code=code

def need(ok,code):
    if not ok: raise Violation(code)

def integer(s):
    need(s!='-0','WIRE_NEGATIVE_ZERO')
    n=int(s);need(abs(n)<=SAFE,'WIRE_INTEGER_RANGE');return n

def no_float(_): raise Violation('WIRE_FLOAT_NOT_ALLOWED')
def pairs(rows):
    result={}
    for k,v in rows:
        need(k not in result,'WIRE_DUPLICATE_KEY');result[k]=v
    return result

def scalar_strings(v):
    if isinstance(v,str):need(not any(0xd800<=ord(c)<=0xdfff for c in v),'WIRE_INVALID_UNICODE')
    elif isinstance(v,list):
        for x in v:scalar_strings(x)
    elif isinstance(v,dict):
        for k,x in v.items():
            scalar_strings(k);scalar_strings(x)

def strict_load(raw):
    need(not raw.startswith(b'\xef\xbb\xbf'),'WIRE_BOM_NOT_ALLOWED')
    try:
        value=json.loads(raw.decode('utf-8',errors='strict'),object_pairs_hook=pairs,parse_int=integer,parse_float=no_float,parse_constant=no_float)
    except (UnicodeDecodeError,json.JSONDecodeError) as e:raise Violation('WIRE_INVALID_JSON') from e
    scalar_strings(value);return value

def canonical(v):
    def keys(x):
        if isinstance(x,dict):
            need(all(re.fullmatch(r'[a-z][a-z0-9_]*',k) for k in x),'WIRE_NON_ASCII_KEY')
            for y in x.values():keys(y)
        elif isinstance(x,list):
            for y in x:keys(y)
    scalar_strings(v);keys(v)
    return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
def sha(v):return hashlib.sha256(canonical(v)).hexdigest()
def text_sha(text):return hashlib.sha256(text.encode('utf-8')).hexdigest()

def span_text(text,s):
    raw=text.encode('utf-16-le')
    need(0<=s['start']<s['end']<=len(raw)//2,'SPAN_RANGE_INVALID')
    try:q=raw[2*s['start']:2*s['end']].decode('utf-16-le',errors='strict')
    except UnicodeDecodeError as e:raise Violation('SPAN_SPLITS_SURROGATE') from e
    if 'quote' in s:need(q==s['quote'],'SPAN_QUOTE_MISMATCH')
    return q

SCHEMA=json.loads((HERE/'schema.json').read_text())
Draft202012Validator.check_schema(SCHEMA)
DECIMAL_PATTERN=next(branch['properties']['value']['pattern'] for branch in SCHEMA['$defs']['TypedValue']['oneOf'] if branch['properties']['kind']['const']=='DECIMAL')

def typed_literal_check(v):
    """Normative literal checks, independent of optional FormatChecker extras.

    The schema currently narrows INSTANT to uppercase T/Z UTC strings. Do not
    widen to offsets or lowercase separators here. Full matches prevent Python
    regex '$' from accepting an otherwise canonical value plus a final newline.
    """
    if isinstance(v,list):
        for x in v:typed_literal_check(x)
    elif isinstance(v,dict):
        kind=v.get('kind')
        if kind in ['DATE','INSTANT','DECIMAL'] and 'value' in v:
            value=v['value'];need(isinstance(value,str),'SCHEMA_INVALID')
            if kind=='DECIMAL':need(re.fullmatch(DECIMAL_PATTERN,value) is not None,'SCHEMA_INVALID')
            else:
                pattern=r'([0-9]{4})-([0-9]{2})-([0-9]{2})' if kind=='DATE' else r'([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?Z'
                match=re.fullmatch(pattern,value);need(match is not None,'SCHEMA_INVALID')
                try:date(*map(int,match.groups()[:3]))
                except ValueError as e:raise Violation('SCHEMA_INVALID') from e
                if kind=='INSTANT':
                    hour,minute,second=map(int,match.groups()[3:6])
                    need(hour<=23 and minute<=59 and second<=59,'SCHEMA_INVALID')
        for x in v.values():typed_literal_check(x)

def schema_check(v,definition):
    checker=Draft202012Validator({'$schema':SCHEMA['$schema'],'$defs':SCHEMA['$defs'],'$ref':'#/$defs/'+definition},format_checker=FormatChecker())
    need(not list(checker.iter_errors(v)),'SCHEMA_INVALID')
    typed_literal_check(v)

def unique(rows,key):need(len({r[key] for r in rows})==len(rows),'DUPLICATE_LOCAL_ID')

def question_check(q):
    need(text_sha(q['text'])==q['text_sha256'],'TEXT_HASH_MISMATCH')
    rs=q['requirements'];unique(rs,'id');unique(q['ambiguities'],'id')
    need(bool(rs)==(q['intent']=='KNOWLEDGE_QUERY'),'INTENT_REQUIREMENTS_MISMATCH')
    unique(q['limitations'],'id')
    ambiguities={a['id'] for a in q['ambiguities']};limitations={a['id'] for a in q['limitations']}
    need(not ambiguities&limitations,'DUPLICATE_LOCAL_ID');open_ids=ambiguities|limitations
    rids={r['id'] for r in rs};condition_ids=set()
    for a in q['ambiguities']:span_text(q['text'],a['mention'])
    for a in q['limitations']:span_text(q['text'],a['mention'])
    used_ambiguities=set()
    for r in rs:
        need(set(r['unresolved'])<=open_ids,'UNKNOWN_AMBIGUITY_REF');used_ambiguities.update(r['unresolved'])
        need(set(r['depends_on'])<=rids and r['id'] not in r['depends_on'],'REQUIREMENT_DEPENDENCY_INVALID')
        sel=r['subjects'];members=sel.get('members',[]);unique(members,'local_id')
        if sel['selector']=='DOCUMENT_GROUP':
            span_text(q['text'],sel['group_mention']);need(set(sel['basis_evidence_ids'])<=EIDS,'UNKNOWN_EVIDENCE_REF')
            group=next((g for g in CONTEXT['groups'] if g['group_ref']==sel['group_ref']),None)
            need(group is not None and group['subject_local_ids']==[m['local_id'] for m in members],'GROUP_REF_UNRESOLVED')
        if sel['selector']=='FAMILY':
            family=FAMILIES.get(sel['family_ref']);need(family is not None and family['subject_slot']['slot_id']==sel['slot_ref'],'FAMILY_REF_UNRESOLVED')
        if sel['selector']=='UNRESOLVED':
            span_text(q['text'],sel['mention']);need(sel['ambiguity_ref'] in r['unresolved'] and sel['ambiguity_ref'] in ambiguities,'UNRESOLVED_SELECTOR_NOT_DECLARED')
        for m in members:
            need(bool(m['question_spans'] or m['source_evidence_ids']),'SUBJECT_WITHOUT_ANCHOR')
            for s in m['question_spans']:span_text(q['text'],s)
            subject_refs(m)
        target=r['target']
        for s in target['question_spans']:span_text(q['text'],s)
        need((bool(target['question_spans']) and target['context_ref'] is None) if target['origin']=='QUESTION' else target['context_ref'] is not None,'TARGET_ORIGIN_INVALID')
        if target['origin']=='CQ_FAMILY':need(target['context_ref'] in FAMILIES,'FAMILY_REF_UNRESOLVED')
        if target['origin']=='USER_DEFINITION':need(target['context_ref'] in CONTEXT['user_definitions'],'USER_DEFINITION_REF_UNRESOLVED')
        if target['predicate_ref'] is not None:need(target['predicate_ref'] in CONTEXT['predicate_refs'],'PREDICATE_REF_UNRESOLVED')
        for c in r['conditions']:
            need(c['id'] not in condition_ids,'DUPLICATE_LOCAL_ID');condition_ids.add(c['id']);span_text(q['text'],c['mention'])
            formal=c['interpretation']=='FORMALIZED'
            need((c['operator']!='UNRESOLVED' and c['value'] is not None) if formal else (c['operator']=='UNRESOLVED' and c['value'] is None and bool(r['unresolved'])),'CONDITION_INTERPRETATION_INVALID')
            if formal:
                need((c['operator'] in ['IN','NOT_IN'])==(c['value']['kind']=='STRING_SET'),'CONDITION_VALUE_TYPE_INVALID')
                if c['operator'] in ['GT','GE','LT','LE']:need(c['value']['kind'] in ['INTEGER','DECIMAL','DATE','INSTANT'],'CONDITION_VALUE_TYPE_INVALID')
        st=r['structure'];need((st is not None)==(r['operation']=='RELATION'),'STRUCTURE_OPERATION_MISMATCH')
        if st:
            need(st['match'] in ['ALL','WITHIN'] if st['kind'] in ['COMBINATION','COMPARISON'] else st['match']=='NOT_APPLICABLE','STRUCTURE_SET_SEMANTICS_INVALID')
            need(st['directionality']!='DIRECTED' or bool(st['roles']),'STRUCTURE_DIRECTION_UNRESOLVED')
            need(st['directionality']!='UNRESOLVED' or bool(r['unresolved']),'STRUCTURE_DIRECTION_UNRESOLVED')
            mids={m['local_id'] for m in members}
            for role in st['roles']:need(set(role['subject_local_ids'])<=mids,'STRUCTURE_ROLE_BINDING_INVALID')
        cov=r['coverage_request'];need(cov['mode']=='EXAMPLES' or cov['limit'] is None,'COVERAGE_LIMIT_INVALID')
    need(used_ambiguities==open_ids,'UNUSED_AMBIGUITY')
    edges={r['id']:r['depends_on'] for r in rs};done=set();visiting=set()
    def visit(k):
        need(k not in visiting,'REQUIREMENT_DEPENDENCY_CYCLE')
        if k in done:return
        visiting.add(k)
        for dep in edges[k]:visit(dep)
        visiting.remove(k);done.add(k)
    for k in edges:visit(k)

EXAMPLES={p.stem:strict_load(p.read_bytes()) for p in sorted((HERE/'examples').glob('*.json'))}
unique([v for v in EXAMPLES.values() if 'question_id' in v and 'text' in v],'question_id')
SPECS={v['question_id']:v for v in EXAMPLES.values() if 'question_id' in v and 'text' in v}
SOURCE_TEXTS={(s['source_ref'],s['source_revision']):s for s in strict_load((FIXTURES/'source-texts.json').read_bytes())['sources']}
EVIDENCE=EXAMPLES['evidence-set'];EIDS={f['id'] for f in EVIDENCE['fragments']}
CONTEXT=strict_load((FIXTURES/'validation-context.json').read_bytes())
FAMILIES={v['family_id']:v for v in EXAMPLES.values() if 'family_id' in v}
EVIDENCE_SETS={v['evidence_set_id']:v for v in EXAMPLES.values() if 'evidence_set_id' in v}
FRAGMENTS={f['id']:f for es in EVIDENCE_SETS.values() for f in es['fragments']}
EIDS=set(FRAGMENTS)

def subject_refs(m):
    need(set(m['source_evidence_ids'])<=EIDS,'UNKNOWN_EVIDENCE_REF')
    if m['entity_ref'] is not None:need(m['entity_ref'] in CONTEXT['entities'],'ENTITY_REF_UNRESOLVED')
    for mention in m['source_mentions']:
        need(mention['evidence_ref'] in m['source_evidence_ids'],'UNKNOWN_EVIDENCE_REF')
        fragment=FRAGMENTS[mention['evidence_ref']];source=SOURCE_TEXTS[(fragment['source_ref'],fragment['source_revision'])]
        span_text(source['text'],mention['span']);need(fragment['span']['start']<=mention['span']['start']<mention['span']['end']<=fragment['span']['end'],'SOURCE_MENTION_OUTSIDE_EVIDENCE')
    if not m['question_spans']:need(bool(m['source_mentions']),'SUBJECT_WITHOUT_ANCHOR')

def snapshot_check(snapshot):
    for s in snapshot['sources']:
        source=SOURCE_TEXTS.get((s['source_ref'],s['source_revision']));need(source is not None,'SOURCE_REVISION_MISMATCH')
        need(s['text_sha256']==text_sha(source['text']),'EVIDENCE_HASH_MISMATCH')
        need(s['original_sha256']==text_sha(source['original_utf8_text']),'ORIGINAL_HASH_MISMATCH')
    need(snapshot in CONTEXT['allowed_snapshots'],'SOURCE_SNAPSHOT_MISMATCH')

def basis_for(ids):
    origins={FRAGMENTS[e]['origin'] for e in ids}
    return 'MIXED' if len(origins)>1 else 'DOCUMENT' if origins=={'SOURCE_FRAGMENT'} else 'GRAPH' if origins else 'NONE'

def trusted_request(request_ref,spec_hash):
    req=next((r for r in CONTEXT['requests'] if r['request_id']==request_ref),None)
    need(req is not None and req['question_spec_sha256']==spec_hash,'REQUEST_CONTEXT_UNRESOLVED');return req['context']

def receipt_check(receipt_ref,kind,report,requirement_id,condition_id=None):
    receipt=next((r for r in CONTEXT['receipts'] if r['receipt_ref']==receipt_ref),None)
    need(receipt is not None and receipt['kind']==kind and receipt['question_spec_sha256']==report['question_spec_sha256'] and receipt['snapshot_sha256']==sha(report['snapshot']) and receipt['requirement_id']==requirement_id and (condition_id is None or receipt['condition_id']==condition_id),'RECEIPT_REF_UNRESOLVED')

def check(v,definition):
    schema_check(v,definition)
    if definition=='QuestionSpec':question_check(v)
    if definition=='CQFamily':
        seed=SPECS.get(v['seed_question_id']);need(seed is not None,'UNKNOWN_QUESTION_REF')
        need(sha(seed)==v['seed_question_spec_sha256'],'SPEC_HASH_MISMATCH')
        byid={r['id']:r for r in seed['requirements']};need(set(v['seed_requirement_ids'])<=set(byid),'UNKNOWN_REQUIREMENT_REF')
        local_ids={m['local_id'] for rid in v['seed_requirement_ids'] for m in byid[rid]['subjects'].get('members',[])}
        need(v['subject_slot']['replace_subject_local_id'] in local_ids,'FAMILY_SLOT_INVALID')
        co=v['cohort_basis'];need(bool(co['user_definition_ref']) if co['kind']=='USER_DEFINED' else bool(co['evidence_ids']) and co['user_definition_ref'] is None,'COHORT_BASIS_MISSING')
        if co['kind']=='USER_DEFINED':need(co['user_definition_ref'] in CONTEXT['user_definitions'],'USER_DEFINITION_REF_UNRESOLVED')
        need(set(co['evidence_ids'])<=EIDS,'UNKNOWN_EVIDENCE_REF');unique(v['members'],'local_id')
        cids={c['id'] for rid in v['seed_requirement_ids'] for c in byid[rid]['conditions']}
        unique(v['condition_transfer'],'condition_id')
        need({c['condition_id'] for c in v['condition_transfer']}==cids,'FAMILY_CONDITION_TRANSFER_INCOMPLETE')
        for m in v['members']:
            need(not m['question_spans'],'FAMILY_MEMBER_QUESTION_SPAN_FORBIDDEN');subject_refs(m)
            need(any(x['span']['quote']==m['label'] for x in m['source_mentions']),'FAMILY_MEMBER_LABEL_UNANCHORED')
    if definition=='EvidenceSet':
        snapshot_check(v['snapshot'])
        ss=v['snapshot']['sources'];unique(ss,'source_ref');unique(v['fragments'],'id')
        sources={(s['source_ref'],s['source_revision']):s for s in ss}
        for f in v['fragments']:
            key=f['source_ref'],f['source_revision'];need(key in sources and key in SOURCE_TEXTS,'SOURCE_REVISION_MISMATCH')
            need(f['text_sha256']==sources[key]['text_sha256']==text_sha(SOURCE_TEXTS[key]['text']),'EVIDENCE_HASH_MISMATCH')
            need(f['block_ref']==SOURCE_TEXTS[key]['block_ref'],'UNKNOWN_BLOCK_REF');span_text(SOURCE_TEXTS[key]['text'],f['span'])
            need(bool(f['claim_refs']) if f['origin']=='PUBLISHED_CLAIM' else not f['claim_refs'],'EVIDENCE_ORIGIN_MISMATCH')
            if f['origin']=='PUBLISHED_CLAIM':
                need(v['snapshot']['graph_revision'] is not None,'GRAPH_SNAPSHOT_MISSING')
                for cid in f['claim_refs']:
                    need(any(c['claim_ref']==cid and c['graph_revision']==v['snapshot']['graph_revision'] and c['status']=='PUBLISHED' and all(c[k]==f[k] for k in ['source_ref','source_revision','block_ref','span']) for c in CONTEXT['claims']),'CLAIM_REF_UNRESOLVED')
    if definition in ['CoverageReport','LearningIntent']:
        q=SPECS.get(v['question_id']);need(q is not None,'UNKNOWN_QUESTION_REF');need(sha(q)==v['question_spec_sha256'],'SPEC_HASH_MISMATCH')
        snapshot_check(v['snapshot'])
        reqs={r['id']:r for r in q['requirements']}
        if definition=='CoverageReport':
            es=EVIDENCE_SETS.get(v['evidence_set_ref']);need(es is not None and es['snapshot']==v['snapshot'],'SOURCE_SNAPSHOT_MISMATCH')
            allowed_ids={f['id'] for f in es['fragments']}
            all_blocks={SOURCE_TEXTS[(s['source_ref'],s['source_revision'])]['block_ref'] for s in v['snapshot']['sources']}
            unique(v['requirements'],'requirement_id');need({r['requirement_id'] for r in v['requirements']}==set(reqs),'REQUIREMENT_COVERAGE_INCOMPLETE')
            for r in v['requirements']:
                expected=reqs[r['requirement_id']];need(set(r['evidence_ids'])<=allowed_ids,'UNKNOWN_EVIDENCE_REF');need(r['basis']==basis_for(r['evidence_ids']),'ANSWER_BASIS_MISMATCH')
                unique(r['condition_receipts'],'condition_id');need({c['id'] for c in expected['conditions']}=={c['condition_id'] for c in r['condition_receipts']},'CONDITION_COVERAGE_INCOMPLETE')
                need(not set(r['checked_block_refs'])&set(r['unsearched_block_refs']),'COVERAGE_BLOCK_OVERLAP')
                need(set(r['checked_block_refs'])|set(r['unsearched_block_refs'])==all_blocks,'COVERAGE_SCOPE_INCOMPLETE')
                unique(r['subject_receipts'],'subject_local_id')
                members=expected['subjects'].get('members',[])
                if members:need({s['subject_local_id'] for s in r['subject_receipts']}=={s['local_id'] for s in members},'SUBJECT_COVERAGE_INCOMPLETE')
                for s in r['subject_receipts']:need(set(s['evidence_ids'])<=set(r['evidence_ids']),'UNKNOWN_EVIDENCE_REF')
                for c in r['condition_receipts']:
                    need(c['status']!='APPLIED' or c['receipt_ref'] is not None,'MISSING_CONDITION_RECEIPT')
                    if c['receipt_ref'] is not None:receipt_check(c['receipt_ref'],'CONDITION_APPLIED',v,r['requirement_id'],c['condition_id'])
                if r['coverage_receipt_ref'] is not None:receipt_check(r['coverage_receipt_ref'],'COVERAGE_AUDIT',v,r['requirement_id'])
                if r['status']=='SATISFIED':
                    need(bool(r['evidence_ids']) and not expected['unresolved'],'UNSUPPORTED_SATISFACTION')
                    need(bool(r['subject_receipts']) and all(s['status']=='SATISFIED' and s['evidence_ids'] for s in r['subject_receipts']),'SUBJECT_COVERAGE_INCOMPLETE')
                    if expected['subjects']['selector']=='FAMILY':need(r['scope_binding_ref'] in CONTEXT['scope_bindings'],'SCOPE_BINDING_UNRESOLVED')
                    need(all(c['status']=='APPLIED' for c in r['condition_receipts']),'CONDITION_NOT_APPLIED')
                    if expected['coverage_request']['mode']=='ALL_IN_SCOPE':need(r['scope_status']=='DECLARED_SCOPE_CHECKED' and not r['unsearched_block_refs'] and r['semantic_coverage']=='AUDITED_IN_SCOPE' and r['coverage_receipt_ref'] is not None,'EXHAUSTIVE_COVERAGE_NOT_ESTABLISHED')
                need(r['semantic_coverage']!='AUDITED_IN_SCOPE' or r['coverage_receipt_ref'] is not None,'MISSING_COVERAGE_RECEIPT')
                if r['status']=='NEEDS_CLARIFICATION':need(set(expected['unresolved'])&{a['id'] for a in q['ambiguities']},'DEMAND_NOT_AMBIGUOUS')
        else:
            access=trusted_request(v['request_ref'],v['question_spec_sha256'])
            need(v['access_mode']==access['access_mode'] and (not v['learning_requested'] or access['learning_requested']),'ACCESS_SCOPE_DENIED')
            need(set(v['requirement_ids'])<=set(reqs),'UNKNOWN_REQUIREMENT_REF');need(set(v['admission_evidence_ids'])<=EIDS,'UNKNOWN_EVIDENCE_REF')
            need(v['learning_requested'] or (v['status']=='NOT_REQUESTED' and v['task_ref'] is None),'LEARNING_NOT_REQUESTED')
            need(v['status']!='NOT_REQUESTED' or (not v['learning_requested'] and v['task_ref'] is None),'LEARNING_NOT_REQUESTED')
            need(v['access_mode']!='QUERY' or (not v['learning_requested'] and v['status']=='NOT_REQUESTED' and v['task_ref'] is None),'ACCESS_SCOPE_DENIED')
            if v['status'] in ['QUEUED','RUNNING','PUBLISHED','WAIT_EVIDENCE','WAIT_REVIEW','FAILED','CANCELLED']:need(v['task_ref'] is not None,'LEARNING_TASK_MISSING')
            if v['status'] in ['RUNNING','PUBLISHED']:need(bool(v['admission_evidence_ids']),'LEARNING_EVIDENCE_MISSING')
    if definition=='DemandEnvelope':
        question_check(v['payload']);need(sha(v['payload'])==v['payload_sha256'],'PAYLOAD_HASH_MISMATCH')
        c=v['context'];need(c['access_mode']!='QUERY' or not c['learning_requested'],'ACCESS_SCOPE_DENIED')
        need(c==trusted_request(v['request_id'],v['payload_sha256']),'ACCESS_SCOPE_DENIED')
    if definition=='AnswerResult':
        q=SPECS.get(v['question_id']);need(q is not None,'UNKNOWN_QUESTION_REF');need(sha(q)==v['question_spec_sha256'],'SPEC_HASH_MISMATCH')
        es=EVIDENCE_SETS.get(v['evidence_set_ref']);need(es is not None and v['snapshot']==es['snapshot'],'SOURCE_SNAPSHOT_MISMATCH')
        access=trusted_request(v['request_ref'],v['question_spec_sha256']);snapshot_check(v['snapshot'])
        reports=[x for x in EXAMPLES.values() if x.get('coverage_report_id')==v['coverage_report_ref']]
        need(len(reports)==1 and reports[0]['question_spec_sha256']==v['question_spec_sha256'],'UNKNOWN_COVERAGE_REF')
        reqs={r['id'] for r in q['requirements']};unique(v['statements'],'id')
        fragments={f['id']:f for f in es['fragments']}
        for s in v['statements']:
            need(set(s['evidence_ids'])<=set(fragments),'UNKNOWN_EVIDENCE_REF');need(set(s['requirement_ids'])<=reqs,'UNKNOWN_REQUIREMENT_REF')
        origins={fragments[e]['origin'] for s in v['statements'] for e in s['evidence_ids']}
        expected='MIXED' if len(origins)>1 else 'DOCUMENT' if origins=={'SOURCE_FRAGMENT'} else 'GRAPH' if origins else 'NONE'
        need(v['basis']==expected,'ANSWER_BASIS_MISMATCH')
        if v['answer_status']=='ANSWERED':
            need(bool(v['statements']) and all(r['status']=='SATISFIED' for r in reports[0]['requirements']),'ANSWER_COVERAGE_INCOMPLETE')
            need({rid for s in v['statements'] for rid in s['requirement_ids']}==reqs,'ANSWER_COVERAGE_INCOMPLETE')
        need(v['learning_state']['status']=='NOT_REQUESTED' or v['learning_state']['task_ref'] is not None,'LEARNING_TASK_MISSING')
        need(v['learning_state']['status']!='NOT_REQUESTED' or v['learning_state']['task_ref'] is None,'LEARNING_NOT_REQUESTED')
        if access['access_mode']=='QUERY' or not access['learning_requested']:need(v['learning_state']=={'status':'NOT_REQUESTED','task_ref':None},'ACCESS_SCOPE_DENIED')


def main():
    mapping={'cq-family':'CQFamily','evidence-set':'EvidenceSet','graph-evidence-set':'EvidenceSet','partial-coverage':'CoverageReport','multi-target-coverage':'CoverageReport','source-answer-coverage':'CoverageReport','background-learning':'LearningIntent','request-envelope':'DemandEnvelope','learning-request-envelope':'DemandEnvelope','source-answer':'AnswerResult','readonly-source-answer':'AnswerResult','source-answer-learning-failed':'AnswerResult'}
    results=[]
    for name,v in EXAMPLES.items():check(v,mapping.get(name,'QuestionSpec'));results.append({'id':'example:'+name,'status':'PASS'})
    for case in strict_load((FIXTURES/'negative-cases.json').read_bytes())['cases']:
        v=copy.deepcopy(EXAMPLES[case['example']])
        for mutation in case['mutations']:
            keys=mutation['path'].strip('/').split('/');cursor=v
            for key in keys[:-1]:cursor=cursor[int(key)] if isinstance(cursor,list) else cursor[key]
            last=int(keys[-1]) if isinstance(cursor,list) else keys[-1]
            if mutation['op']=='remove':del cursor[last]
            else:cursor[last]=mutation['value']
        try:check(v,case['definition'])
        except Violation as e:need(e.code==case['expected_code'],'UNEXPECTED_ERROR:'+case['id']+':'+e.code)
        else:raise Violation('INVALID_CASE_ACCEPTED:'+case['id'])
        results.append({'id':case['id'],'status':'PASS'})
    wire=strict_load((FIXTURES/'wire-vectors.json').read_bytes());u=wire['unicode'];need(text_sha(u['text'])==u['text_sha256'],'WIRE_VECTOR_HASH')
    need(len(u['text'].encode('utf-16-le'))//2==u['utf16_length'] and len(u['text'].encode())==u['utf8_length'],'WIRE_VECTOR_LENGTH')
    for s in u['valid_spans']:
        part=span_text(u['text'],s);need(part.encode()==u['text'].encode()[s['utf8_start']:s['utf8_end']],'OFFSET_CONVERSION_MISMATCH')
    for s in u['invalid_spans']:
        try:span_text(u['text'],s)
        except Violation:pass
        else:raise Violation('INVALID_SPAN_ACCEPTED')
    can=wire['canonical'];need(canonical(can['input_a'])==canonical(can['input_b'])==can['canonical_utf8'].encode(),'CANONICAL_VECTOR_MISMATCH');need(sha(can['input_a'])==can['sha256'],'CANONICAL_HASH_MISMATCH')
    for raw in wire['invalid_json_texts']:
        try:strict_load(raw.encode())
        except Violation:pass
        else:raise Violation('INVALID_WIRE_ACCEPTED')
    for raw in wire['invalid_bytes_hex']:
        try:strict_load(bytes.fromhex(raw))
        except Violation:pass
        else:raise Violation('INVALID_WIRE_ACCEPTED')
    for n in wire['safe_integers']:need(strict_load(str(n).encode())==n,'INTEGER_VECTOR_MISMATCH')
    for changed in wire['text_version_changes']:
        need(text_sha(changed['text'])==changed['text_sha256'] and changed['text_sha256']!=u['text_sha256'],'TEXT_VERSION_VECTOR_MISMATCH')
    for expected,values in wire['decimal_values'].items():
        for s in values:
            try:schema_check({'kind':'DECIMAL','value':s},'TypedValue');valid=True
            except Violation:valid=False
            need(valid==(expected=='valid'),'DECIMAL_VECTOR_MISMATCH')
    results.append({'id':'wire:unicode-canonical-strict-json-decimal','status':'PASS'})
    print(json.dumps({'status':'SPEC_FIXTURES_PASSED','contract_version':'lightog-demand/0.1','examples':len(EXAMPLES),'negative_cases':len(results)-len(EXAMPLES)-1,'wire_vectors':'PASS','actual_model_calls':0,'rust_implementation':'SEPARATE_KERNEL_SEE_RUST_REPORT','product_integration':'NOT_IMPLEMENTED','semantic_quality':'NOT_MEASURED','results':results},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
