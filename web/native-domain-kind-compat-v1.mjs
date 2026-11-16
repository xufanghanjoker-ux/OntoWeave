/** Explicit vocabulary equivalence only; never infer a type from a name or text. */
const aliases=new Map(Object.entries({
 ENTITY:'ENTITY',OBJECT:'ENTITY','实体':'ENTITY','对象':'ENTITY',
 EVENT:'EVENT','事件':'EVENT',CONCEPT:'CONCEPT','概念':'CONCEPT',TYPE:'TYPE',CLASS:'TYPE','类型':'TYPE','类别':'TYPE',
 DEFINITION:'DEFINITION','定义':'DEFINITION',RELATION:'RELATION',RELATIONSHIP:'RELATION','关系':'RELATION','关系陈述':'RELATION',
 ATTRIBUTE:'ATTRIBUTE',PROPERTY:'ATTRIBUTE','属性':'ATTRIBUTE','属性陈述':'ATTRIBUTE',
 RULE:'RULE','规则':'RULE','规则陈述':'RULE',TEXT:'TEXT','文本':'TEXT','知识文本':'TEXT',STATEMENT:'STATEMENT','陈述':'STATEMENT','事实陈述':'STATEMENT',
 FORMULA:'FORMULA','公式':'FORMULA',CLASSIFICATION:'CLASSIFICATION','分类':'CLASSIFICATION'
}));
export function normalizeDomainKind(value){const token=typeof value==='string'?value.normalize('NFKC').trim().toUpperCase():'';return {original:value??null,kind:aliases.get(token)??null,basis:aliases.has(token)?'EXPLICIT_KIND_VOCABULARY_V1':'UNSUPPORTED_KIND'};}
