/** Check compiled demand against an executable plan; never infer demand from a catalog. */
import {isStructuralPredicate} from './structure-learning.mjs';

export const DEMAND_BINDING_VERSION='demand_plan_consistency_v1';

export function demandPlanConflict(requirement,plan,schema){
  if(!requirement)return null; // Legacy typed callers have no compiled natural-language demand.
  if(requirement.mode==='ATTRIBUTE')return plan.template==='STRUCTURE'
    ?'属性需求不能改为主体关系或模式查询。':null;
  if(requirement.mode!=='RELATIONSHIP')return '问题需求模式无效。';
  const predicate=schema.predicates.find(p=>p.id===plan.predicate_id);
  const composition=requirement.kinds.length===1&&requirement.kinds[0]==='COMPOSITION'
    &&plan.template==='FACTS'&&predicate?.value_type==='ENTITY'&&isStructuralPredicate(schema,predicate);
  if(composition)return null;
  if(plan.template!=='STRUCTURE')return '关系需求不能用普通属性查询代替。';
  if((plan.structure_match||'ALL')!==requirement.structure_match)return '结构查询的主体集合语义与本次需求不一致。';
  if(new Set(requirement.kinds).size===1&&!plan.structure_kind)return '单一结构类别需求不能使用不限类别的查询计划。';
  if(plan.structure_kind&&!requirement.kinds.includes(plan.structure_kind))return '结构查询类别不属于本次需求。';
  return null;
}

export function assertDemandPlan(requirement,plan,schema,{source}={}){
  if(!requirement)return {contract:DEMAND_BINDING_VERSION,status:'NOT_APPLICABLE',source};
  const conflict=demandPlanConflict(requirement,plan,schema);
  if(conflict)throw Object.assign(Error('本次问题理解与查询计划未通过一致性检查，未执行查询或新增学习，请稍后重试。'),{
    code:'SYSTEM_DEMAND_PLAN_CONFLICT',details:{contract:DEMAND_BINDING_VERSION,source,reason:conflict,
      requirement:{mode:requirement.mode,kinds:requirement.kinds,structure_match:requirement.structure_match},
      plan:{template:plan.template,predicate_id:plan.predicate_id,structure_kind:plan.structure_kind??null,structure_match:plan.structure_match??null}}
  });
  return {contract:DEMAND_BINDING_VERSION,status:'CONSISTENT',source};
}
