//! Serializable data types for `lightog-demand/0.1` and `lightog-wire/0.1`.
//!
//! These types describe proposals and records, not NLP accuracy, semantic truth,
//! trusted authorization, or source validity. The shared schema and contextual
//! validators remain authoritative for bounds, references and invariants.
//!
//! Nullable fields are serialized explicitly as `null` (no skip attributes).
//! Serde accepts a missing `Option<T>` as `None`; therefore the raw JSON must
//! pass the schema's required-field checks before deserializing a core object.
//! Likewise, integer safety, text spans, uniqueness and nonempty strings/arrays
//! are validated separately rather than implied by a successful deserialization.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContractVersion {
    #[serde(rename = "lightog-demand/0.1")]
    V0_1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireVersion {
    #[serde(rename = "lightog-wire/0.1")]
    V0_1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OffsetUnit {
    #[serde(rename = "utf16_code_unit")]
    Utf16CodeUnit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionSpan {
    pub start: u64,
    pub end: u64,
    pub quote: String,
    pub offset_unit: OffsetUnit,
}

/// A source span has a separate owner and validator from a question span.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSpan {
    pub start: u64,
    pub end: u64,
    pub quote: String,
    pub offset_unit: OffsetUnit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum TypedValue {
    String {
        value: String,
    },
    Integer {
        value: i64,
    },
    /// An exact canonical decimal string; never an IEEE-754 float.
    Decimal {
        value: String,
    },
    Boolean {
        value: bool,
    },
    Date {
        value: String,
    },
    Instant {
        value: String,
    },
    StringSet {
        value: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMention {
    pub evidence_ref: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectTerm {
    pub local_id: String,
    pub label: String,
    pub question_spans: Vec<QuestionSpan>,
    pub entity_ref: Option<String>,
    pub source_evidence_ids: Vec<String>,
    pub source_mentions: Vec<SourceMention>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "selector",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum SubjectSelector {
    Explicit {
        members: Vec<SubjectTerm>,
    },
    DocumentGroup {
        group_ref: String,
        group_mention: QuestionSpan,
        members: Vec<SubjectTerm>,
        basis_evidence_ids: Vec<String>,
    },
    Family {
        family_ref: String,
        slot_ref: String,
    },
    Unresolved {
        mention: QuestionSpan,
        ambiguity_ref: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TargetOrigin {
    Question,
    UserDefinition,
    CqFamily,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub label: String,
    pub question_spans: Vec<QuestionSpan>,
    pub predicate_ref: Option<String>,
    pub origin: TargetOrigin,
    pub context_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConditionField {
    TargetValue,
    Scope,
    Unit,
    Modality,
    ValidTime,
    SourceTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConditionOperator {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    In,
    NotIn,
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConditionInterpretation {
    Formalized,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub id: String,
    pub mention: QuestionSpan,
    pub field: ConditionField,
    pub operator: ConditionOperator,
    pub value: Option<TypedValue>,
    pub interpretation: ConditionInterpretation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StructureKind {
    Relation,
    Combination,
    Comparison,
    Composition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StructureMatch {
    All,
    Within,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StructureRole {
    Subject,
    Object,
    Whole,
    Part,
    Dependent,
    Provider,
    Participant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleBinding {
    pub role: StructureRole,
    pub subject_local_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Directionality {
    Directed,
    Undirected,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Structure {
    pub kind: StructureKind,
    pub r#match: StructureMatch,
    pub roles: Vec<RoleBinding>,
    pub directionality: Directionality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AmbiguityReason {
    Identity,
    Reference,
    Target,
    ConditionScope,
    BooleanScope,
    TimeInterpretation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ambiguity {
    pub id: String,
    pub question: String,
    pub mention: QuestionSpan,
    pub reason: AmbiguityReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LimitationReason {
    BooleanExpressionUnsupported,
    TimeSemanticsUnsupported,
    OperationUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limitation {
    pub id: String,
    pub mention: QuestionSpan,
    pub reason: LimitationReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Operation {
    Explain,
    List,
    Compare,
    Filter,
    Relation,
    Rule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoverageRequestMode {
    Unspecified,
    Examples,
    AllInScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageRequest {
    pub mode: CoverageRequestMode,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub operation: Operation,
    pub subjects: SubjectSelector,
    pub target: Target,
    pub conditions: Vec<Condition>,
    pub structure: Option<Structure>,
    pub coverage_request: CoverageRequest,
    pub depends_on: Vec<String>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Intent {
    KnowledgeQuery,
    AssistantIdentity,
    Greeting,
    ProductHelp,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionSpec {
    pub contract_version: ContractVersion,
    pub question_id: String,
    pub text: String,
    pub text_sha256: String,
    pub intent: Intent,
    pub requirements: Vec<Requirement>,
    pub ambiguities: Vec<Ambiguity>,
    pub limitations: Vec<Limitation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectSlot {
    pub slot_id: String,
    pub replace_subject_local_id: String,
    pub role: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpansionPolicy {
    #[serde(rename = "SAME_ASPECT_ONLY")]
    SameAspectOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CohortBasisKind {
    DocumentClassification,
    DocumentComparisonGroup,
    UserDefined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CohortBasis {
    pub kind: CohortBasisKind,
    pub evidence_ids: Vec<String>,
    pub user_definition_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConditionTransferPolicy {
    Invariant,
    SubjectSpecific,
    RequiresRecheck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionTransfer {
    pub condition_id: String,
    pub policy: ConditionTransferPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CQFamily {
    pub contract_version: ContractVersion,
    pub family_id: String,
    pub seed_question_id: String,
    pub seed_requirement_ids: Vec<String>,
    pub subject_slot: SubjectSlot,
    pub expansion_policy: ExpansionPolicy,
    pub cohort_basis: CohortBasis,
    pub condition_transfer: Vec<ConditionTransfer>,
    pub members: Vec<SubjectTerm>,
    pub seed_question_spec_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceVersion {
    pub source_ref: String,
    pub source_revision: String,
    pub original_sha256: String,
    pub text_sha256: String,
    pub parser_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSnapshot {
    pub base_ref: String,
    pub source_epoch: u64,
    pub graph_revision: Option<String>,
    pub sources: Vec<SourceVersion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceOrigin {
    SourceFragment,
    PublishedClaim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceRole {
    Primary,
    Context,
    Condition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceFragment {
    pub id: String,
    pub origin: EvidenceOrigin,
    pub source_ref: String,
    pub source_revision: String,
    pub block_ref: String,
    pub text_sha256: String,
    pub span: SourceSpan,
    pub claim_refs: Vec<String>,
    pub role: EvidenceRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSet {
    pub contract_version: ContractVersion,
    pub evidence_set_id: String,
    pub snapshot: SourceSnapshot,
    pub fragments: Vec<EvidenceFragment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoverageStatus {
    Satisfied,
    Partial,
    Unsupported,
    NeedsClarification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceBasis {
    Graph,
    Document,
    Mixed,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConditionReceiptStatus {
    Applied,
    Unsupported,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionReceipt {
    pub condition_id: String,
    pub status: ConditionReceiptStatus,
    pub receipt_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubjectReceiptStatus {
    Satisfied,
    Partial,
    NoSupport,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectReceipt {
    pub subject_local_id: String,
    pub status: SubjectReceiptStatus,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScopeStatus {
    Local,
    DeclaredScopeChecked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SemanticCoverage {
    NotAssessed,
    AuditedInScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequirementCoverage {
    pub requirement_id: String,
    pub status: CoverageStatus,
    pub basis: EvidenceBasis,
    pub evidence_ids: Vec<String>,
    pub condition_receipts: Vec<ConditionReceipt>,
    pub checked_block_refs: Vec<String>,
    pub unsearched_block_refs: Vec<String>,
    pub scope_status: ScopeStatus,
    pub semantic_coverage: SemanticCoverage,
    pub coverage_receipt_ref: Option<String>,
    pub reason: String,
    pub subject_receipts: Vec<SubjectReceipt>,
    pub scope_binding_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageReport {
    pub contract_version: ContractVersion,
    pub coverage_report_id: String,
    pub question_id: String,
    pub question_spec_sha256: String,
    pub snapshot: SourceSnapshot,
    pub requirements: Vec<RequirementCoverage>,
    pub evidence_set_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccessMode {
    Query,
    Learn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LearningStatus {
    NotRequested,
    Queued,
    Running,
    Published,
    WaitEvidence,
    WaitReview,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LearningIntent {
    pub contract_version: ContractVersion,
    pub question_id: String,
    pub question_spec_sha256: String,
    pub requirement_ids: Vec<String>,
    pub snapshot: SourceSnapshot,
    pub access_mode: AccessMode,
    pub learning_requested: bool,
    pub status: LearningStatus,
    pub task_ref: Option<String>,
    pub admission_evidence_ids: Vec<String>,
    pub request_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AnswerStatus {
    Answered,
    Partial,
    NeedsClarification,
    NoRelevantEvidence,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerStatement {
    pub id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
    pub requirement_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LearningState {
    pub status: LearningStatus,
    pub task_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerResult {
    pub contract_version: ContractVersion,
    pub question_id: String,
    pub question_spec_sha256: String,
    pub snapshot: SourceSnapshot,
    pub evidence_set_ref: String,
    pub answer_status: AnswerStatus,
    pub basis: EvidenceBasis,
    pub statements: Vec<AnswerStatement>,
    pub coverage_report_ref: String,
    pub learning_state: LearningState,
    pub request_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessContext {
    pub base_ref: String,
    pub source_epoch: u64,
    pub access_mode: AccessMode,
    pub learning_requested: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "DEMAND_PROPOSAL")]
    DemandProposal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemandEnvelope {
    pub wire_version: WireVersion,
    pub request_id: String,
    pub message_type: MessageType,
    pub payload_sha256: String,
    pub context: AccessContext,
    pub payload: QuestionSpec,
}

/// Convenience sum of the schema's top-level alternatives. The wire contract
/// has no common discriminant; validate against a known definition when one is
/// supplied by the transport, before constructing this untagged convenience.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DemandDocument {
    QuestionSpec(QuestionSpec),
    CQFamily(CQFamily),
    EvidenceSet(EvidenceSet),
    CoverageReport(CoverageReport),
    LearningIntent(LearningIntent),
    AnswerResult(AnswerResult),
    DemandEnvelope(DemandEnvelope),
}
