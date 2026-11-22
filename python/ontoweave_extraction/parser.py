"""Deterministic, record-local parsing. Original bytes are never rewritten."""
import re,math
from . import POLICY_VERSION
ALIASES={
    '谓语': '谓词',
    '关系短语': '谓词',
    '属性名': '谓词',
    '实体名称': '名称',
    '实体类型': '类型',
}
FIELDS=set('名称 类别 类型 别名 来源 主体 谓词 客体 数值 文本值 布尔值 空值 复合值 单位 限定 限定实体 限定值 时间角色 时间原文 原述 否定 归因 状态 条件 理由'.split())
CATEGORY=dict(zip('行动 事件 观测 评价 概念'.split(),'ACTION EVENT OBSERVATION EVALUATION CONCEPT'.split()))
TIME=dict(zip('发生 开始 结束 计划 观测 报告 截止 参考'.split(),'OCCURRED STARTED ENDED PLANNED_FOR OBSERVED_AT REPORTED_AT DEADLINE REFERENCE'.split()))
HEADERS={'实体','事实','无相关知识'}
VALUE_KEYS=['客体','数值','文本值','布尔值','空值','复合值']

def parse(raw,policy=POLICY_VERSION):
    v3=policy.startswith('open-statements/')
    text=raw.decode('utf-8',errors='strict'); lines=text.splitlines(keepends=True)
    rows=[];pos=0
    for line in lines:
        rows.append((pos,pos+len(line.encode()),line.rstrip('\r\n')));pos+=len(line.encode())
    repairs=[]; nonempty=[i for i,r in enumerate(rows) if r[2].strip()]
    if len(nonempty)>=2 and rows[nonempty[0]][2] in ('```','```text','```plaintext') and rows[nonempty[-1]][2]=='```' and sum(r[2].startswith('```') for r in rows)==2:
        rows=rows[nonempty[0]+1:nonempty[-1]];repairs.append('UNWRAP_SINGLE_OUTER_FENCE')
    records=[];end_positions=[];outside=[];current=None;fence=None;last_field=None
    def flush(end):
        nonlocal current,last_field
        if current:
            current['end']=end;current['raw_utf8']=raw[current['start']:end].decode();records.append(normalize(current,policy))
        current=None;last_field=None
    for start,end,line in rows:
        if line.startswith('  '):
            if current and last_field is not None:current['fields'][last_field]['value']+='\n'+line[2:]
            elif line.strip():outside.append(dict(start=start,code='ORPHAN_CONTINUATION'))
            continue
        if line.startswith('```') or line.startswith('~~~'):
            marker=line[:3]
            if fence is None:fence=marker
            elif fence==marker:fence=None
            if current:current['diagnostics'].append('LOCAL_FENCE_UNINTERPRETED')
            else:outside.append(dict(start=start,code='LOCAL_FENCE_UNINTERPRETED'))
            last_field=None;continue
        if fence:
            if current:current.setdefault('unparsed',[]).append(line)
            continue
        if line in HEADERS:
            flush(start);current=dict(kind=line,start=start,fields=[],diagnostics=[]);continue
        if line=='抽取结束':
            flush(start);end_positions.append(start);continue
        if not line.strip():continue
        match=re.match(r'^([^：:]+)[：:](.*)$',line)
        if current and match:
            original,value=match.groups();key=ALIASES.get(original,original)
            if v3 and original=='原文表述':key='原述'
            if key not in FIELDS:current['diagnostics'].append('UNKNOWN_LABEL:'+original)
            if key!=original:current.setdefault('repairs',[]).append('LABEL_ALIAS:'+original)
            current['fields'].append(dict(key=key,original_label=original,value=value.lstrip(' '),start=start,end=end));last_field=len(current['fields'])-1
        elif current:
            current['diagnostics'].append('UNPARSED_LINE');current.setdefault('unparsed',[]).append(line);last_field=None
        else:outside.append(dict(start=start,code='UNBOUNDED_TEXT'))
    flush(len(raw))
    visible=[r for r in rows if r[2].strip()]
    end='EXPLICIT' if len(end_positions)==1 and visible and visible[-1][2]=='抽取结束' and visible[-1][0]==end_positions[0] else 'INVALID' if end_positions else 'MISSING'
    if fence:outside.append(dict(code='UNBALANCED_FENCE'))
    no_knowledge=any(r['kind']=='无相关知识' and r.get('reason') and not r['blocking'] for r in records)
    facts=[r for r in records if r['kind']=='事实']
    if no_knowledge and facts:outside.append(dict(code='NO_KNOWLEDGE_CONFLICT'))
    return dict(policy_version=policy,records=records,end_declaration=end,legal_no_knowledge=no_knowledge and not facts,diagnostics=outside,repairs=repairs)

def normalize(rec,policy=POLICY_VERSION):
    fields=rec['fields'];diag=rec['diagnostics'];rec['blocking']=False
    def single(key):
        vals=list(dict.fromkeys(f['value'] for f in fields if f['key']==key))
        if len(vals)>1:diag.append('CONFLICTING_FIELD:'+key);rec['blocking']=True
        return vals[0] if len(vals)==1 else None
    rec['sources']=list(dict.fromkeys(f['value'] for f in fields if f['key']=='来源'))
    rec['qualifiers']=[];rec['times']=[]
    for rolekey,valuekeys,target,mapping in [('限定',('限定实体','限定值'),'qualifiers',{}),('时间角色',('时间原文',),'times',TIME)]:
        pending=None
        for f in fields:
            if f['key']==rolekey:
                if pending is not None:diag.append('UNPAIRED_ROLE:'+rolekey)
                pending=dict(role_raw=f['value'],role=mapping.get(f['value'],f['value']),value=None)
                if mapping and f['value'] not in mapping:diag.append('UNKNOWN_TIME_ROLE:'+f['value'])
                rec[target].append(pending)
            elif f['key'] in valuekeys:
                if pending is None:diag.append('ORPHAN_PAIR_VALUE:'+f['key']);rec[target].append(dict(role_raw=None,role=None,value=f['value'],value_kind=f['key']))
                else:pending.update(value=f['value'],value_kind=f['key']);pending=None
        if pending is not None:diag.append('UNPAIRED_ROLE:'+rolekey)
    if rec['kind']=='无相关知识':
        rec['reason']=single('理由')
        if not rec['reason']:diag.append('NO_KNOWLEDGE_REASON_MISSING');rec['blocking']=True
    elif rec['kind']=='实体':
        rec['name']=single('名称');rec['category_raw']=single('类别');rec['category']=CATEGORY.get(rec['category_raw'],rec['category_raw']);rec['type']=single('类型')
        rec['aliases']=list(dict.fromkeys(f['value'] for f in fields if f['key']=='别名'))
        if rec['category_raw'] and rec['category_raw'] not in CATEGORY:diag.append('UNKNOWN_CATEGORY:'+rec['category_raw'])
        if not rec['name']:diag.append('ENTITY_NAME_MISSING');rec['blocking']=True
    else:
        rec['subject']=single('主体');rec['predicate']=single('谓词');rec['unit']=single('单位')
        vals=[(key,single(key)) for key in VALUE_KEYS if any(f['key']==key for f in fields)]
        rec['extras']={k:[f['value'] for f in fields if f['key']==k] for k in ['原述','否定','归因','状态','条件'] if any(f['key']==k for f in fields)}
        rec['value_kind']=None;rec['value']=None;rec['value_raw']=None
        if len(vals)==1:
            key,value=vals[0];rec.update(value_kind=key,value=value,value_raw=value)
            if value is not None:
                if key=='数值':
                    if re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?',value):
                        try:
                            number=int(value) if re.fullmatch(r'[+-]?\d+',value) else float(value)
                            if not math.isfinite(number):raise ValueError()
                            rec['value']=number
                        except (ValueError,OverflowError):diag.append('INVALID_NUMERIC');rec['blocking']=True
                    else:diag.append('INVALID_NUMERIC');rec['blocking']=True
                elif key=='布尔值':
                    if value in ('true','false'):rec['value']=value=='true'
                    else:diag.append('INVALID_BOOLEAN');rec['blocking']=True
                elif key=='空值':
                    if value=='null':rec['value']=None
                    else:diag.append('INVALID_NULL');rec['blocking']=True
                elif key=='复合值':diag.append('COMPOSITE_UNINTERPRETED');rec['blocking']=True
        elif len(vals)>1:diag.append('OBJECT_VALUE_CONFLICT');rec['blocking']=True
        if not rec['subject'] or not rec['predicate'] or len(vals)!=1 or vals[0][1] is None:
            diag.append('FACT_BACKBONE_MISSING');rec['blocking']=True
        rec['disposition']='STRUCTURED' if rec['subject'] and rec['predicate'] and len(vals)==1 and vals[0][1] is not None and not any(d.startswith(('CONFLICTING_FIELD','INVALID_','OBJECT_VALUE')) for d in diag) else 'PRESERVED' if (rec['subject'] and rec['predicate']) or rec['extras'].get('原述') or any(d.startswith('CONFLICTING_FIELD') for d in diag) else 'SKIPPED'
    # Unresolved qualifiers retain the backbone, but remain a visible task gap.
    if any(d.startswith(('UNKNOWN_LABEL','UNPARSED','UNPAIRED','ORPHAN','LOCAL_FENCE')) for d in diag):rec['blocking']=True
    return normalize_open(rec) if policy.startswith('open-statements/') else rec


def normalize_open(rec):
    """Open interpretation preserves lexical evidence, never repairs semantics."""
    fields=rec['fields'];diag=rec['diagnostics'];extensions=[]
    consumed={'名称','类别','类型','别名','来源','主体','谓词','客体','数值','文本值','布尔值','空值','复合值','单位','限定','限定实体','限定值','时间角色','时间原文','原述','理由'}
    for f in fields:
        if f['key'] not in consumed:
            kind='LEGACY_POLARITY_UNINTERPRETED' if f['key']=='否定' else 'UNINTERPRETED_EXTENSION'
            extensions.append(dict(label=f['original_label'],canonical_label=f['key'],value=f['value'],interpretation=None,diagnostic=kind))
            if kind not in diag:diag.append(kind)
    rec['extensions']=extensions
    if rec['kind']=='实体':
        rec['category']=rec.get('category_raw')
        rec['diagnostics']=[d for d in diag if not d.startswith('UNKNOWN_CATEGORY:')]
    elif rec['kind']=='事实':
        # Composite values are intentionally open, never advertised as structured.
        if rec.get('value_kind')=='复合值':rec['disposition']='PRESERVED'
        readable=bool(rec.get('subject') or rec.get('predicate') or rec.get('extras',{}).get('原述') or extensions or any(f['key'] in VALUE_KEYS and f['value'] for f in fields))
        if rec['disposition']=='SKIPPED' and readable:rec['disposition']='PRESERVED'
        rec['structure_usable']=rec['disposition']=='STRUCTURED'
    rec['content_warnings']=list(rec['diagnostics'])
    # This flag describes content only. Execution settles independently in v3.
    rec['content_gap']=bool(rec['blocking'] or extensions or rec.get('disposition')=='PRESERVED')
    return rec
