//! Pure, versioned LightOG demand validation. No models, storage, network or job dispatch.
mod context;
pub mod evidence_bridge;
pub mod knowledge_contract;
pub mod learning_contract;
mod literals;
mod question;
pub mod types;
mod validate;
pub mod wire;
pub mod production;
pub use context::ValidationContext;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
}
impl Error {
    pub fn new(code: &'static str) -> Self {
        Self { code }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub fn need(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::new(code))
    }
}

pub struct Kernel {
    validators: BTreeMap<String, jsonschema::Validator>,
}
impl Kernel {
    pub fn new() -> Result<Self> {
        let schema: Value =
            serde_json::from_str(include_str!("../../../contracts/demand-v0.1/schema.json"))
                .map_err(|_| Error::new("KERNEL_SCHEMA_INVALID"))?;
        let defs = schema["$defs"]
            .as_object()
            .ok_or_else(|| Error::new("KERNEL_SCHEMA_INVALID"))?;
        let mut validators = BTreeMap::new();
        for key in defs.keys() {
            let wrapper = serde_json::json!({"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":defs,"$ref":format!("#/$defs/{key}")});
            let validator = jsonschema::draft202012::options()
                .should_validate_formats(true)
                .build(&wrapper)
                .map_err(|_| Error::new("KERNEL_SCHEMA_INVALID"))?;
            validators.insert(key.clone(), validator);
        }
        Ok(Self { validators })
    }
    pub fn schema_check(&self, value: &Value, definition: &str) -> Result<()> {
        let validator = self
            .validators
            .get(definition)
            .ok_or_else(|| Error::new("SCHEMA_DEFINITION_UNKNOWN"))?;
        need(
            validator.is_valid(value) && literals::valid(value),
            "SCHEMA_INVALID",
        )
    }
    pub fn validate(&self, value: &Value, definition: &str, ctx: &ValidationContext) -> Result<()> {
        self.schema_check(value, definition)?;
        // Schema required/null constraints run before serde Option deserialization.
        macro_rules! typed {
            ($t:ty) => {{
                let _: $t = serde_json::from_value(value.clone())
                    .map_err(|_| Error::new("SCHEMA_INVALID"))?;
            }};
        }
        match definition {
            "QuestionSpec" => typed!(types::QuestionSpec),
            "CQFamily" => typed!(types::CQFamily),
            "EvidenceSet" => typed!(types::EvidenceSet),
            "CoverageReport" => typed!(types::CoverageReport),
            "LearningIntent" => typed!(types::LearningIntent),
            "AnswerResult" => typed!(types::AnswerResult),
            "DemandEnvelope" => typed!(types::DemandEnvelope),
            "TypedValue" => typed!(types::TypedValue),
            _ => {}
        }
        validate::validate(value, definition, ctx)
    }
}
