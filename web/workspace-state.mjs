/** Local-only draft allowlist. This contract never grants permission to send data. */
import assert from 'node:assert/strict';
import { sha } from './engine.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=/^[a-f0-9-]{36}$/;
function field(value,max,label,fallback=''){
  if(value===undefined)return fallback;
  assert(typeof value==='string'&&value.length<=max,label+'格式无效或过长');return value;
}
const questions=value=>typeof value==='string'?value.split('\n').map(s=>s.trim()).filter(Boolean):value;

export function validateWorkspaceDraft(value,{getDocument,getProposal=()=>null}={}){
  if(value===null)return null;
  assert(object(value),'草稿必须是对象或null');
  const cqs=value.cqs===undefined?'':value.cqs;
  if(Array.isArray(cqs))assert(cqs.length<=12&&cqs.every(q=>typeof q==='string'&&q.length<=500),'草稿CQ最多12条，每条500字符');
  else {field(cqs,6012,'草稿CQ');assert(questions(cqs).length<=12&&questions(cqs).every(q=>q.length<=500),'草稿CQ最多12条，每条500字符');}
  const as_of=field(value.as_of,10,'查询日期');
  assert(!as_of||(/^\d{4}-\d{2}-\d{2}$/.test(as_of)&&Number.isFinite(Date.parse(as_of))&&new Date(as_of).toISOString().slice(0,10)===as_of),'草稿查询日期无效');
  const sources=value.sources===undefined?[]:value.sources;
  assert(Array.isArray(sources)&&sources.length<=8,'草稿最多8份资料');
  const cleanSources=sources.map(source=>{
    assert(object(source),'草稿资料格式无效');
    const title=field(source.title,180,'资料标题'),content=field(source.content,Infinity,'资料正文');
    if(source.document_id!==undefined){
      assert(typeof source.document_id==='string'&&uuid.test(source.document_id),'文档标识无效');
      assert(typeof getDocument==='function','无法核验上传文档');
      const parsed=getDocument(source.document_id);
      assert(parsed&&parsed.document_id===source.document_id&&parsed.content===content,'上传资料已变化，不能沿用旧解析证据；请重新上传');
      const parsing={};for(const key of ['document_id','title','extension','original_sha256','original_bytes','created_at','parser','parser_version','content','parsed_sha256','blocks','warnings','offset_unit']){
        if(parsed[key]!==undefined)parsing[key]=structuredClone(parsed[key]);
      }
      return {title,content,document_id:source.document_id,parsing};
    }
    return {title,content};
  });
  const clean={name:field(value.name,100,'知识模型名称'),cqs:structuredClone(cqs),definitions:field(value.definitions,3000,'业务定义'),as_of,sources:cleanSources};
  if(value.proposalSelected!==undefined){assert(Array.isArray(value.proposalSelected)&&value.proposalSelected.length<=12
    &&new Set(value.proposalSelected).size===value.proposalSelected.length&&value.proposalSelected.every(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(id)),
  '候选选择格式无效');clean.proposalSelected=[...value.proposalSelected];}
  if(value.proposalAnswers!==undefined){
    assert(object(value.proposalAnswers)&&Object.keys(value.proposalAnswers).length<=5,'澄清回答格式无效');
    clean.proposalAnswers={};for(const [id,answer] of Object.entries(value.proposalAnswers)){
      assert(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(id),'澄清标识无效');
      assert(!/secret|password|api.?key|authorization|consent|budget|token/i.test(id),'澄清标识不能包含凭据或授权字段');
      clean.proposalAnswers[id]=field(answer,1000,'澄清回答');
    }
  }
  if(value.proposal_id!==undefined){
    assert(typeof value.proposal_id==='string'&&uuid.test(value.proposal_id),'CQ建议标识无效');
    const proposal=getProposal(value.proposal_id),input=proposal?.confirmed_input;
    // Only the server's actual confirmation plus the exact input snapshot can restore this pointer.
    if(proposal?.status==='CONFIRMED'&&input&&input.name===clean.name&&input.definitions===clean.definitions
      &&(input.as_of||'')===as_of&&JSON.stringify(input.cqs.map(q=>q.question))===JSON.stringify(questions(cqs))
      &&input.sources.length===cleanSources.length&&input.sources.every((s,i)=>s.title===cleanSources[i].title&&s.sha256===sha(cleanSources[i].content)))clean.proposal_id=value.proposal_id;
  }
  return clean;
}

export function questionBacklogItem(taskId,question,now=new Date().toISOString()){
  assert(typeof question==='string'&&question.trim()&&question.length<=1000,'待扩展问题需要1–1000字符');
  const normalized=question.trim();
  return {id:'question_'+sha({task_id:taskId,question:normalized}).slice(0,32),task_id:taskId,version:taskId,question:normalized,created_at:now};
}
