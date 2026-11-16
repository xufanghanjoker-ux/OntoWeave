/** Original synthetic fixture; no private brand data or external sources. Not a live model evaluation. */
import { dimensions } from '../tools/evaluator-gate.mjs';
export const body = () => ({ name: '图存储验收 · 合成资料', consent: true,
  definitions: '服务地区指明确提供服务的地区，不是办公室所在地。所有实体均为虚构。',
  cqs: ['甲服务商覆盖哪些地区？', '哪些服务商覆盖欧洲？', '甲乙服务商的覆盖地区有何不同？'],
  sources: [{ title: '合成能力说明 · v1', content: '甲服务商在欧洲和亚洲提供服务。乙服务商在欧洲提供服务。' }] });
export const schema = () => ({ entity_types: [{ id: 'company', label: '服务商' }],
  entities: [{ id: 'a', name: '甲服务商', type: 'company' }, { id: 'b', name: '乙服务商', type: 'company' }],
  predicates: [{ id: 'region', label: '服务地区', value_type: 'STRING', unit: null, cardinality: 'MANY' }],
  cq_plans: [
    { cq_id: 'CQ-01', template: 'FACTS', subject_id: 'a', predicate_id: 'region', object_value: null },
    { cq_id: 'CQ-02', template: 'ENTITIES', subject_id: null, predicate_id: 'region', object_value: '欧洲' },
    { cq_id: 'CQ-03', template: 'COMPARE', subject_id: null, subject_ids: ['a', 'b'], predicate_id: 'region', object_value: null }
  ] });
export const rawClaim = (subject_id, value, quote, extra = {}) => ({ subject_id, predicate_id: 'region', value,
  quote, source_id: 'source_1', modality: 'CURRENT', comparator: 'EQ', unit: null, scope: null, effective_from: null, ...extra });
export const claims = () => [rawClaim('a', '欧洲', '甲服务商在欧洲和亚洲提供服务。'),
  rawClaim('a', '亚洲', '甲服务商在欧洲和亚洲提供服务。'), rawClaim('b', '欧洲', '乙服务商在欧洲提供服务。')];
export function mockProvider({ invalidQuote = false } = {}) {
  let calls = 0;
  const review = { coverage: Object.fromEntries(dimensions.map(d => [d, 'CHECKED'])), issues: [] };
  const responses = [{ schema: schema() }, { supported_scopes: [], unknowns: [], potential_errors: [] }, review,
    { claims: invalidQuote ? [...claims(), rawClaim('a', '美洲', '不存在的原文')] : claims() }, review];
  return { model: 'OFFLINE_MOCK_NOT_A_REAL_REVIEW', get calls() { return calls; },
    async complete(messages) {
      let output;
      if(messages){
        const prompt=messages[0].content,payload=JSON.parse(messages[1].content);
        if(prompt.includes('问题需求编译器'))output={requirements:payload.cqs.map(q=>({cq_id:q.id,intent:'KNOWLEDGE_QUERY',relevance:'IN_SCOPE',mode:'ATTRIBUTE',kinds:[],structure_match:'ALL',reason:'合成属性需求'}))};
        else if(prompt.includes('CQForge结构候选发现器'))output={candidates:[]};
        else if(prompt.includes('CQForge Builder'))output={schema:schema()};
        else if(payload.packet)output=review;
        else if(prompt.includes('CQForge Extractor')){
          const source=payload.sources[0];
          output={claims:claims().filter(c=>source.text.includes(c.quote)).map(c=>({...c,source_id:source.id}))};
          if(invalidQuote)output.claims.push({...rawClaim('a','美洲','不存在的原文'),source_id:source.id});
        }else output={supported_scopes:[],unknowns:[],potential_errors:[]};
        calls++;
      }else{if(calls>=responses.length)throw Error('超出预期调用数');output=responses[calls++];}
      return { content: JSON.stringify(output), usage: {}, requested_model: 'OFFLINE_MOCK_NOT_A_REAL_REVIEW' };
    } };
}
