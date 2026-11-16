/** New proposal prompt only. Frozen symbols/v2 materialization stays unchanged.
 * No execution of models, semantic normalization or correction of old outputs.
 */
import { prepareExtractionCall as prepareSymbols,
  materializeExtractionResult as materializeSymbols,
  ADAPTER_VERSION, SYMBOL_PROJECTION_VERSION,
} from '../p2/extraction-symbols-v1.mjs';

export { ADAPTER_VERSION, SYMBOL_PROJECTION_VERSION };
export const PROPOSAL_PROMPT_VERSION = 'lightog-p2-semantic-proposal/0.1';

const semanticInstructions = `
Semantic fidelity for this new proposal version (the JSON schema is unchanged):
1. One fact has exactly one explicit subject. Select its registry key from the entity actually making or receiving this claim in the relevant source clause. The fact description must name that subject surface and its object/value explicitly. Do not transfer a neighboring clause's subject, negation or restriction. A co-occurring source anchor only locates a term; it does not prove that a relation applies to it.
2. Distinguish a type/concept from an instance/example. A generic type, a named instance, and a worked example are not interchangeable. type_label is a source-grounded category proposal, not a declaration that every member inherits the instance's property. Do not infer class-wide relations from one example, a shared word, an alias or a heading.
3. Encode polarity once: use an affirmative base predicate label and description, and express the fact's negative assertion only with qualifiers.negated=true. The fact description must still faithfully state the original negative assertion. For a positive assertion use the same affirmative base predicate and qualifiers.negated=false. Do not use a negative predicate label plus negated=true (double negation), and do not reinterpret an intrinsically different predicate as a negative one. If the source's polarity or its subject scope cannot be resolved, do not invent a polarity. This is a proposal instruction, not permission for the host to flip or rewrite an existing output.
4. Every condition belongs to this fact's subject and predicate. Use the existing condition.text to name that subject and base predicate and describe exactly when/for whom that fact applies; use condition.evidence_ids for the source clause that actually states it. Keep exceptions, prerequisites and alternatives distinct. Never attach another subject's condition or treat mere mention evidence as condition support. Do not add new schema fields for condition ownership.
5. Keep example scope. If a claim is made only in a sample, hypothetical, version, test, role, region or mode, preserve that restriction in qualifiers.scope and the fact description; retain applicable conditions. Do not turn example behavior into a general promise, an intention into current behavior, or absence of evidence into a negative claim. Keep time/modality/units as stated, without defaults from outside knowledge.
6. Only fact support evidence can substantiate domain semantics. Registry anchor evidence proves term location only; aliases, headings, CQ targets and unrelated source snippets cannot supply missing subject/predicate/condition support. Do not expand support_evidence_ids merely to make a structurally valid relation. Distinct facts can share the same registry anchor while needing different supporting clauses.
Instruction-only examples, never extraction content:
- Source pattern: “设备甲不能跨区运行；设备乙在授权后可以跨区运行。” Use separate subjects and the affirmative base predicate “跨区运行”. 甲 has negated=true. 乙 has negated=false and a condition whose text makes clear “设备乙的跨区运行仅在授权后适用”. Do not put 乙's authorization condition onto 甲.
- Source pattern: “在演示样例中，样机甲可以执行动作。” Keep the demonstration/sample scope. Do not infer that the device type or every device can execute that action.
- Source pattern: “类别丙的一项示例是实例丁。” Keep category and instance distinct; an instance attribute is not automatically a category attribute.
These examples are instructions, not source evidence. Extract only from the supplied evidence_menu. Unknown semantic support remains unverified; the host fixes IDs/anchors/service status only and a separate review decides eligibility.`;

export function prepareExtractionCall(prepared, options = {}) {
  const call = prepareSymbols(prepared, options);
  return { ...call, proposal_prompt_version: PROPOSAL_PROMPT_VERSION,
    messages: [{ ...call.messages[0], content: call.messages[0].content + semanticInstructions },
      ...call.messages.slice(1)] };
}

export function materializeExtractionResult(prepared, raw, options = {}) {
  return { ...materializeSymbols(prepared, raw, options), proposal_prompt_version: PROPOSAL_PROMPT_VERSION };
}
