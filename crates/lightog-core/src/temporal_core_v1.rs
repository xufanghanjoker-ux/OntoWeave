//! Deterministic fact-version bitemporal semantics. No database, clock, model or I/O.
use crate::common::{canonical_hash, error, Result};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, NaiveDateTime, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Precision { #[default] Exact, Minute, Day, Month, Year, Unknown }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TimePoint {
    pub value: Option<String>,
    #[serde(default)] pub precision: Precision,
    #[serde(default)] pub raw: Option<String>,
    #[serde(default)] pub basis: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum TimeEnd { Exact { point: TimePoint }, OpenAsReported, Unknown }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum WorldTime {
    State { start: Option<TimePoint>, end: TimeEnd },
    Event { occurred_at: TimePoint },
    Window { start: TimePoint, end: TimePoint },
    Timeless { basis: String },
    Unknown { raw: Option<String>, basis: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactContent {
    pub subject_ref: String,
    pub predicate: String,
    pub value: Value,
    #[serde(default)] pub conditions: Value,
    #[serde(default)] pub negated: bool,
    #[serde(default = "asserted")] pub modality: String,
}
fn asserted() -> String { "ASSERTED".into() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateGroup { pub key: String, #[serde(default)] pub single_valued: bool }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SourceRole { Support, Background }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SourceKind { Document, Observation, HumanRevision, SourceRevision }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceRef {
    pub source_version_id: String,
    pub role: SourceRole,
    pub kind: SourceKind,
    #[serde(default)] pub quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SuccessionAuthority { OntologySingleValue, ExplicitHandover, UserDecision }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactAssertion {
    pub content: FactContent,
    pub valid_time: WorldTime,
    #[serde(default)] pub state_group: Option<StateGroup>,
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Head { pub activation_seq: u64, pub activation_ref: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SystemInterval {
    pub from_seq: u64,
    pub to_seq: Option<u64>,
    pub recorded_from: String,
    pub recorded_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EndDerivation {
    pub successor_fact_id: String,
    pub successor_start: String,
    pub authority: SuccessionAuthority,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactVersion {
    pub fact_id: String,
    pub fact_version_id: String,
    pub content: FactContent,
    pub asserted_valid_time: WorldTime,
    pub valid_time: WorldTime,
    pub state_group: Option<StateGroup>,
    pub sources: Vec<SourceRef>,
    pub supersedes: Option<String>,
    pub derivation: Option<EndDerivation>,
    pub succession_authority: Option<SuccessionAuthority>,
    pub update_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub system: Option<SystemInterval>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SupportLink {
    pub support_link_id: String,
    pub fact_version_id: String,
    pub source: SourceRef,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub system: Option<SystemInterval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Base { pub head: Head, pub versions: Vec<FactVersion>, pub support_links: Vec<SupportLink> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum Update {
    AddFact { assertion: FactAssertion, reason: String },
    StateChange { assertion: FactAssertion, authority: Option<SuccessionAuthority>, reason: String },
    Correct { target_version_id: String, assertion: FactAssertion, reason: String },
    Withdraw { target_version_id: String, basis: SourceRef, reason: String },
    AddSupport { target_version_id: String, source: SourceRef, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest { pub request_id: String, pub library_id: String, pub base: Base, pub updates: Vec<Update> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Warning { pub code: String, pub fact_id: Option<String>, pub message: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupDigest { pub key: String, pub digest: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseVersion {
    pub fact_version_id: String,
    pub reason: String,
    pub basis: Option<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeSet {
    pub request_id: String,
    pub library_id: String,
    pub base_head: Head,
    pub base_digest: String,
    pub affected_group_digests: Vec<GroupDigest>,
    pub new_versions: Vec<FactVersion>,
    pub close_versions: Vec<CloseVersion>,
    pub add_supports: Vec<SupportLink>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizeRequest {
    pub times: Vec<WorldTime>,
    /// Transport-only hints: never added to persisted TimePoint or historical hashes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timezone_hints: Vec<TimezoneHint>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimezoneHint { pub time_index: usize, pub point: String, pub timezone: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizeResult { pub times: Vec<WorldTime>, pub warnings: Vec<Warning> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectRequest {
    pub selected_seq: u64,
    pub at: Option<TimePoint>,
    pub versions: Vec<FactVersion>,
    pub support_links: Vec<SupportLink>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedFact { pub fact: FactVersion, pub sources: Vec<SourceRef>, pub reasons: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Selection { pub supported: Vec<SelectedFact>, pub possible: Vec<SelectedFact>, pub excluded: Vec<SelectedFact> }

fn bad(code: &str, message: impl Into<String>) -> crate::common::CoreError { error(code, message) }
fn required(v: &str, field: &str) -> Result<()> {
    if v.trim().is_empty() { Err(bad("TEMPORAL_INPUT_INVALID", format!("{field} is empty"))) } else { Ok(()) }
}
fn warn(warnings: &mut Vec<Warning>, code: &str, fact_id: Option<&str>, message: &str) {
    warnings.push(Warning { code: code.into(), fact_id: fact_id.map(str::to_owned), message: message.into() });
}
fn instant(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|d| d.with_timezone(&Utc))
}
fn exact(point: &TimePoint) -> Option<DateTime<Utc>> {
    if point.precision == Precision::Exact { point.value.as_deref().and_then(instant) } else { None }
}
fn minute_start(value: &str) -> Option<DateTime<Utc>> {
    let parsed = instant(value).or_else(|| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M%#z").ok().map(|d| d.with_timezone(&Utc)))?;
    parsed.with_second(0)?.with_nanosecond(0)
}
/// The latest bound is an exact instant for EXACT and an exclusive supremum for MINUTE.
/// It is used conservatively: an uncertain start is definitely passed only at that bound.
fn point_bounds(point: &TimePoint) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    match point.precision {
        Precision::Exact => exact(point).map(|t| (t,t)),
        Precision::Minute => {
            let start = minute_start(point.value.as_deref()?)?;
            Some((start, start.checked_add_signed(Duration::minutes(1))?))
        }
        _ => None,
    }
}
fn point_at(value: String, basis: String) -> TimePoint {
    TimePoint { raw: Some(value.clone()), value: Some(value), precision: Precision::Exact, basis: Some(basis) }
}
fn normalize_point(point: &mut TimePoint, warnings: &mut Vec<Warning>) {
    let Some(value) = point.value.clone() else {
        warn(warnings, "TIME_UNKNOWN", None, "Missing time value retained as unknown"); return;
    };
    if point.raw.is_none() { point.raw = Some(value.clone()); }
    match point.precision {
        Precision::Exact => {
            if let Some(time) = instant(&value) {
                point.value = Some(time.to_rfc3339_opts(SecondsFormat::AutoSi, true));
            } else {
                // Local date/time is preserved, never assigned an upload/system timezone.
                let local = NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
                    || NaiveDate::parse_from_str(&value, "%Y-%m-%d").is_ok();
                point.precision = Precision::Unknown;
                warn(warnings, if local { "TIMEZONE_UNKNOWN" } else { "TIME_INVALID" }, None,
                    "Unresolved exact time retained; cannot establish a definite instant");
            }
        }
        Precision::Minute => {
            if let Some(start) = minute_start(&value) {
                point.value = Some(start.to_rfc3339_opts(SecondsFormat::AutoSi, true));
                warn(warnings, "TIME_MINUTE_PRECISION", None, "Minute value retained as a range of compatible instants, not an exact second");
            } else {
                warn(warnings, "TIMEZONE_OR_MINUTE_UNRESOLVED", None, "Minute precision retained without assuming an offset");
            }
        }
        Precision::Day => {
            if NaiveDate::parse_from_str(&value, "%Y-%m-%d").is_err() {
                point.precision = Precision::Unknown;
                warn(warnings, "TIME_INVALID", None, "Invalid day retained as unknown");
            } else { warn(warnings, "TIME_COARSE", None, "Day precision has no exact offset instant"); }
        }
        Precision::Month | Precision::Year | Precision::Unknown => {
            warn(warnings, "TIME_COARSE_OR_UNKNOWN", None, "Coarse or unknown time cannot establish a definite instant");
        }
    }
}
fn normalize_world(time: &mut WorldTime, warnings: &mut Vec<Warning>) -> Result<()> {
    match time {
        WorldTime::State { start, end } => {
            if let Some(start) = start.as_mut() { normalize_point(start, warnings); }
            if let TimeEnd::Exact { point } = &mut *end { normalize_point(point, warnings); }
            if let (Some(a), TimeEnd::Exact { point: b }) = (start.as_ref(), &*end) {
                if let (Some(a), Some(b)) = (exact(a), exact(b)) {
                    if b <= a { return Err(bad("TEMPORAL_INTERVAL_INVALID", "State end must be after start")); }
                }
            }
        }
        WorldTime::Event { occurred_at } => normalize_point(occurred_at, warnings),
        WorldTime::Window { start, end } => {
            normalize_point(start, warnings); normalize_point(end, warnings);
            if let (Some((earliest_start, _)), Some((_, latest_end))) = (point_bounds(start), point_bounds(end)) {
                if latest_end <= earliest_start { return Err(bad("TEMPORAL_INTERVAL_INVALID", "Window has no compatible positive interval")); }
            }
        }
        WorldTime::Timeless { basis } => required(basis, "timeless basis")?,
        WorldTime::Unknown { .. } => warn(warnings, "TIME_UNKNOWN", None, "World time remains unknown"),
    }
    Ok(())
}
fn fixed_offset(text: &str) -> Option<FixedOffset> {
    let upper = text.trim().to_ascii_uppercase();
    if upper.is_empty() { return None; }
    let value = upper.strip_prefix("UTC").or_else(|| upper.strip_prefix("GMT")).unwrap_or(&upper);
    if value.is_empty() || value == "Z" { return FixedOffset::east_opt(0); }
    let bytes = value.as_bytes();
    if bytes.len() != 6 || !matches!(bytes[0], b'+' | b'-') || bytes[3] != b':'
        || ![bytes[1],bytes[2],bytes[4],bytes[5]].iter().all(u8::is_ascii_digit) { return None; }
    let hours = (bytes[1]-b'0') as i32*10+(bytes[2]-b'0') as i32;
    let minutes = (bytes[4]-b'0') as i32*10+(bytes[5]-b'0') as i32;
    if hours > 23 || minutes > 59 { return None; }
    FixedOffset::east_opt((hours*3600+minutes*60)*if bytes[0] == b'-' { -1 } else { 1 })
}
fn apply_timezone(point: &mut TimePoint, timezone: &str, warnings: &mut Vec<Warning>) {
    if point.raw.is_none() { point.raw = point.value.clone(); }
    let Some(offset) = fixed_offset(timezone) else {
        point.precision = Precision::Unknown;
        warn(warnings,"TIMEZONE_UNSUPPORTED",None,"Unsupported independent timezone retained as unknown; no IANA/DST assumption"); return;
    };
    if !matches!(point.precision, Precision::Exact | Precision::Minute) { return; }
    let Some(value) = point.value.clone() else { return; };
    if point.raw.is_none() { point.raw = Some(value.clone()); }
    let embedded = DateTime::parse_from_rfc3339(&value).ok()
        .or_else(|| DateTime::parse_from_str(&value,"%Y-%m-%dT%H:%M%#z").ok());
    if let Some(embedded) = embedded {
        if embedded.offset().local_minus_utc() != offset.local_minus_utc() {
            point.precision = Precision::Unknown;
            warn(warnings,"TIMEZONE_CONFLICT",None,"Embedded and independent offsets conflict; time retained as unknown");
        }
    } else {
        // Parse local input before attaching an explicit source offset; never append to malformed/offset text.
        let local = NaiveDateTime::parse_from_str(&value,"%Y-%m-%dT%H:%M:%S%.f").is_ok()
            || point.precision == Precision::Minute && NaiveDateTime::parse_from_str(&value,"%Y-%m-%dT%H:%M").is_ok();
        if local { point.value = Some(format!("{value}{offset}")); }
    }
}
pub fn normalize_time(mut request: NormalizeRequest) -> Result<NormalizeResult> {
    let mut warnings = vec![];
    let mut seen = BTreeSet::new();
    for hint in request.timezone_hints {
        if !seen.insert((hint.time_index,hint.point.clone())) { return Err(bad("TEMPORAL_TIMEZONE_HINT_INVALID","Duplicate endpoint timezone hint")); }
        let point = match (request.times.get_mut(hint.time_index), hint.point.as_str()) {
            (Some(WorldTime::State {start:Some(point),..}),"START")
            | (Some(WorldTime::State {end:TimeEnd::Exact {point},..}),"END")
            | (Some(WorldTime::Window {start:point,..}),"START")
            | (Some(WorldTime::Window {end:point,..}),"END")
            | (Some(WorldTime::Event {occurred_at:point}),"OCCURRED_AT") => point,
            _ => return Err(bad("TEMPORAL_TIMEZONE_HINT_INVALID","Timezone hint endpoint missing")),
        };
        apply_timezone(point,&hint.timezone,&mut warnings);
    }
    for time in &mut request.times { normalize_world(time, &mut warnings)?; }
    Ok(NormalizeResult { times: request.times, warnings })
}

fn validate_source(source: &SourceRef) -> Result<()> { required(&source.source_version_id, "source_version_id") }
fn normalize_assertion(assertion: &mut FactAssertion, warnings: &mut Vec<Warning>) -> Result<()> {
    required(&assertion.content.subject_ref, "subject_ref")?;
    required(&assertion.content.predicate, "predicate")?;
    required(&assertion.content.modality, "modality")?;
    if let Some(group) = &assertion.state_group { required(&group.key, "state_group.key")?; }
    if !assertion.sources.iter().any(|s| s.role == SourceRole::Support) {
        return Err(bad("TEMPORAL_SOURCE_REQUIRED", "Assertion needs an exact support source revision"));
    }
    for source in &assertion.sources { validate_source(source)?; }
    normalize_world(&mut assertion.valid_time, warnings)
}
fn system_visible(system: &SystemInterval, seq: u64) -> bool {
    system.from_seq <= seq && system.to_seq.is_none_or(|to| seq < to)
}
fn validate_system(system: &SystemInterval) -> Result<()> {
    if system.from_seq == 0 || system.to_seq.is_some_and(|to| to <= system.from_seq) {
        return Err(bad("TEMPORAL_SYSTEM_INTERVAL_INVALID", "Invalid adoption sequence interval"));
    }
    let from = instant(&system.recorded_from).ok_or_else(|| bad("TEMPORAL_SYSTEM_TIME_INVALID", "recorded_from needs offset ISO"))?;
    match (&system.recorded_to, system.to_seq) {
        (Some(to), Some(_)) => {
            let to = instant(to).ok_or_else(|| bad("TEMPORAL_SYSTEM_TIME_INVALID", "recorded_to needs offset ISO"))?;
            if to < from { return Err(bad("TEMPORAL_SYSTEM_TIME_INVALID", "System clock moved backwards")); }
        }
        (None, None) => (),
        _ => return Err(bad("TEMPORAL_SYSTEM_INTERVAL_INVALID", "Sequence and timestamp ends disagree")),
    }
    Ok(())
}
fn digest_parts(versions: &[FactVersion], links: &[SupportLink]) -> String {
    let mut versions = versions.to_vec();
    versions.sort_by(|a,b| a.fact_version_id.cmp(&b.fact_version_id));
    let mut support_links = links.to_vec();
    support_links.sort_by(|a,b| a.support_link_id.cmp(&b.support_link_id));
    canonical_hash(&json!({"versions": versions, "support_links": support_links}))
}
pub fn base_digest(base: &Base) -> String { digest_parts(&base.versions, &base.support_links) }
pub fn group_digest(base: &Base, key: &str) -> String {
    let versions: Vec<_> = base.versions.iter().filter(|v| v.state_group.as_ref().is_some_and(|g| g.key == key)).cloned().collect();
    let ids: BTreeSet<_> = versions.iter().map(|v| v.fact_version_id.as_str()).collect();
    let links: Vec<_> = base.support_links.iter().filter(|s| ids.contains(s.fact_version_id.as_str())).cloned().collect();
    digest_parts(&versions, &links)
}
fn generated_id(prefix: &str, seed: &Value) -> String { format!("{prefix}_{}", canonical_hash(seed)) }
fn group_key(fact: &FactVersion) -> Option<&str> { fact.state_group.as_ref().map(|g| g.key.as_str()) }
fn state_start(fact: &FactVersion) -> Option<DateTime<Utc>> {
    match &fact.asserted_valid_time { WorldTime::State { start: Some(start), .. } => exact(start), _ => None }
}
fn build_version(fact_id: String, assertion: FactAssertion, reason: String, authority: Option<SuccessionAuthority>) -> FactVersion {
    FactVersion { fact_id, fact_version_id: String::new(), content: assertion.content,
        asserted_valid_time: assertion.valid_time.clone(), valid_time: assertion.valid_time,
        state_group: assertion.state_group, sources: assertion.sources, supersedes: None,
        derivation: None, succession_authority: authority, update_reason: reason, system: None }
}
fn target<'a>(versions: &'a BTreeMap<String, FactVersion>, version_id: &str) -> Result<&'a FactVersion> {
    versions.values().find(|v| v.fact_version_id == version_id)
        .ok_or_else(|| bad("TEMPORAL_TARGET_NOT_CURRENT", format!("Exact current version unavailable: {version_id}")))
}
fn authority_of(fact: &FactVersion) -> Option<SuccessionAuthority> {
    fact.succession_authority.clone()
}
fn recompute_group(versions: &mut BTreeMap<String, FactVersion>, key: &str, warnings: &mut Vec<Warning>) {
    let mut ordered: Vec<_> = versions.values().filter(|v| group_key(v) == Some(key))
        .filter_map(|v| state_start(v).map(|t| (t, v.fact_id.clone()))).collect();
    ordered.sort();
    for (_, id) in &ordered {
        let fact = versions.get_mut(id).unwrap();
        fact.valid_time = fact.asserted_valid_time.clone();
        fact.derivation = None;
    }
    for i in 0..ordered.len() {
        let (start, id) = &ordered[i];
        let same_start = ordered.iter().filter(|(t, _)| t == start).count() > 1;
        if same_start {
            warn(warnings, "STATE_START_CONFLICT", Some(id), "Concurrent statements share the same exact state start; both remain statements");
        }
        let Some((successor_start, successor_id)) = ordered.iter().skip(i + 1).find(|(t, _)| t > start) else { continue; };
        if ordered.iter().filter(|(t, _)| t == successor_start).count() > 1 {
            warn(warnings, "STATE_SUCCESSOR_AMBIGUOUS", Some(id), "Conflicting successors at the same start cannot supply an arbitrary end binding"); continue;
        }
        let successor = &versions[successor_id];
        if authority_of(successor).is_none() {
            warn(warnings, "SUCCESSION_NOT_AUTHORIZED", Some(id), "Same group does not by itself authorize unique state succession"); continue;
        }
        // A typed group key must bind the same subject, predicate, condition scope and modality.
        let predecessor = &versions[id];
        if predecessor.content.subject_ref != successor.content.subject_ref
            || predecessor.content.predicate != successor.content.predicate
            || predecessor.content.conditions != successor.content.conditions
            || predecessor.content.modality != successor.content.modality
            || predecessor.content.negated != successor.content.negated {
            warn(warnings, "STATE_GROUP_SCOPE_MISMATCH", Some(id), "Exact group key contains different business scope; no inferred end"); continue;
        }
        let successor_iso = successor_start.to_rfc3339_opts(SecondsFormat::AutoSi, true);
        let authority = authority_of(successor).unwrap();
        let fact = versions.get_mut(id).unwrap();
        if let WorldTime::State { end, .. } = &mut fact.valid_time {
            match end {
                TimeEnd::Exact { point } => {
                    if let Some(source_end) = exact(point) {
                        if source_end <= *successor_start {
                            if source_end < *successor_start { warn(warnings, "STATE_TIMELINE_GAP", Some(id), "Explicit source end preserved before successor start"); }
                            continue;
                        }
                        warn(warnings, "SOURCE_END_SUCCESSION_CONFLICT", Some(id), "Explicit source end overlaps successor; adopted end is bounded by successor");
                    } else {
                        warn(warnings, "SOURCE_END_UNRESOLVED", Some(id), "Coarse or unknown source end preserved; succession cannot determine exact end"); continue;
                    }
                }
                TimeEnd::Unknown => {
                    warn(warnings, "STATE_END_UNKNOWN", Some(id), "Unknown source end remains unknown; no assumption of continued state"); continue;
                }
                TimeEnd::OpenAsReported => (),
            }
            *end = TimeEnd::Exact { point: point_at(successor_iso.clone(), "SUCCESSOR_START".into()) };
            fact.derivation = Some(EndDerivation { successor_fact_id: successor_id.clone(), successor_start: successor_iso, authority });
        }
    }
}

pub fn prepare_change_set(request: PrepareRequest) -> Result<ChangeSet> {
    required(&request.request_id, "request_id")?; required(&request.library_id, "library_id")?;
    let mut originals = BTreeMap::new();
    let mut version_ids = BTreeSet::new();
    for version in &request.base.versions {
        required(&version.fact_id, "fact_id")?; required(&version.fact_version_id, "fact_version_id")?;
        let system = version.system.as_ref().ok_or_else(|| bad("TEMPORAL_BASE_UNADOPTED", "Base version is not adopted"))?;
        validate_system(system)?;
        if !system_visible(system, request.base.head.activation_seq) { return Err(bad("TEMPORAL_BASE_NOT_CURRENT", "Base must contain only head-visible versions")); }
        if !version_ids.insert(version.fact_version_id.clone()) || originals.insert(version.fact_id.clone(), version.clone()).is_some() {
            return Err(bad("TEMPORAL_BASE_DUPLICATE", "Duplicate current fact or version"));
        }
    }
    let mut link_ids = BTreeSet::new();
    for link in &request.base.support_links {
        validate_source(&link.source)?;
        let system = link.system.as_ref().ok_or_else(|| bad("TEMPORAL_BASE_UNADOPTED", "Base support is not adopted"))?;
        validate_system(system)?;
        if !system_visible(system, request.base.head.activation_seq) || !version_ids.contains(&link.fact_version_id) || !link_ids.insert(&link.support_link_id) {
            return Err(bad("TEMPORAL_BASE_SUPPORT_INVALID", "Base support must be unique and visible on a current version"));
        }
    }
    let mut working = originals.clone();
    let mut affected = BTreeSet::new();
    let mut recalculate = BTreeSet::new();
    let mut touched = BTreeSet::new();
    let mut withdrawal = BTreeMap::new();
    let mut add_supports = vec![];
    let mut warnings = vec![];
    for (index, update) in request.updates.iter().cloned().enumerate() {
        let unauthorized_change = matches!(&update, Update::StateChange { authority: None, .. });
        match update {
            Update::AddFact { mut assertion, reason } | Update::StateChange { mut assertion, authority: None, reason } => {
                required(&reason, "reason")?; normalize_assertion(&mut assertion, &mut warnings)?;
                let fact_id = generated_id("fact", &json!([request.library_id, request.request_id, index]));
                let version = build_version(fact_id.clone(), assertion, reason, None);
                if let Some(key) = group_key(&version) {
                    affected.insert(key.to_owned());
                    // Late predecessors may be bounded by an already authorized successor.
                    // An ADD_FACT never obtains authority to close an earlier assertion.
                    if working.values().any(|v| group_key(v) == Some(key) && v.succession_authority.is_some()) {
                        recalculate.insert(key.to_owned());
                    }
                }
                if unauthorized_change {
                    warn(&mut warnings, "SUCCESSION_NOT_AUTHORIZED", Some(&fact_id), "State change retained as independent assertion without succession authority");
                }
                working.insert(fact_id, version);
            }
            Update::StateChange { mut assertion, authority: Some(authority), reason } => {
                required(&reason, "reason")?; normalize_assertion(&mut assertion, &mut warnings)?;
                let fact_id = generated_id("fact", &json!([request.library_id, request.request_id, index]));
                let version = build_version(fact_id.clone(), assertion, reason, Some(authority.clone()));
                if authority == SuccessionAuthority::OntologySingleValue && !version.state_group.as_ref().is_some_and(|g| g.single_valued) {
                    return Err(bad("TEMPORAL_SUCCESSION_AUTHORITY_INVALID", "Ontology authority requires an explicit single-valued group"));
                }
                if let Some(key) = group_key(&version) {
                    affected.insert(key.into());
                    if state_start(&version).is_some() { recalculate.insert(key.into()); }
                    else { warn(&mut warnings, "STATE_START_UNRESOLVED", Some(&fact_id), "State change needs an exact state start before succession"); }
                } else { warn(&mut warnings, "STATE_GROUP_REQUIRED", Some(&fact_id), "State change has no exact group; retained independently"); }
                working.insert(fact_id, version);
            }
            Update::Correct { target_version_id, mut assertion, reason } => {
                required(&reason, "reason")?;
                let old = target(&originals, &target_version_id)?.clone();
                if !touched.insert(old.fact_id.clone()) { return Err(bad("TEMPORAL_MULTIPLE_TARGET_UPDATES", "Only one correction/withdrawal per fact in a batch")); }
                normalize_assertion(&mut assertion, &mut warnings)?;
                let mut previous_sources = old.sources.clone();
                previous_sources.extend(request.base.support_links.iter().filter(|s| s.fact_version_id == old.fact_version_id).map(|s| s.source.clone()));
                let old_sources: BTreeSet<_> = previous_sources.iter().map(|s| s.source_version_id.as_str()).collect();
                if !assertion.sources.iter().any(|s| s.role == SourceRole::Support
                    && matches!(s.kind, SourceKind::HumanRevision | SourceKind::SourceRevision)
                    && !old_sources.contains(s.source_version_id.as_str())) {
                    return Err(bad("TEMPORAL_CORRECTION_BASIS_REQUIRED", "Correction requires a new human/source revision supporting its new assertion"));
                }
                for source in &previous_sources {
                    if !assertion.sources.iter().any(|s| s.source_version_id == source.source_version_id) {
                        let mut background = source.clone(); background.role = SourceRole::Background;
                        assertion.sources.push(background);
                    } else if assertion.sources.iter().any(|s| s.source_version_id == source.source_version_id && s.role == SourceRole::Support) {
                        return Err(bad("TEMPORAL_CORRECTION_OLD_SOURCE_REUSED", "Old source must be background for a revised assertion"));
                    }
                }
                if let Some(key) = group_key(&old) { affected.insert(key.into()); recalculate.insert(key.into()); }
                let mut version = build_version(old.fact_id.clone(), assertion, reason, old.succession_authority.clone());
                version.supersedes = Some(old.fact_version_id);
                if let Some(key) = group_key(&version) { affected.insert(key.into()); recalculate.insert(key.into()); }
                working.insert(version.fact_id.clone(), version);
            }
            Update::Withdraw { target_version_id, basis, reason } => {
                required(&reason, "reason")?; validate_source(&basis)?;
                let old = target(&originals, &target_version_id)?;
                if !touched.insert(old.fact_id.clone()) { return Err(bad("TEMPORAL_MULTIPLE_TARGET_UPDATES", "Only one correction/withdrawal per fact in a batch")); }
                if let Some(key) = group_key(old) { affected.insert(key.into()); recalculate.insert(key.into()); }
                withdrawal.insert(old.fact_version_id.clone(), (reason, basis)); working.remove(&old.fact_id);
            }
            Update::AddSupport { target_version_id, source, reason } => {
                required(&reason, "reason")?; validate_source(&source)?;
                if source.role != SourceRole::Support { return Err(bad("TEMPORAL_SOURCE_ROLE_INVALID", "New support must have SUPPORT role")); }
                let old = target(&originals, &target_version_id)?;
                if let Some(key) = group_key(old) { affected.insert(key.into()); }
                let exists = old.sources.iter().any(|s| s == &source)
                    || request.base.support_links.iter().any(|s| s.fact_version_id == target_version_id && s.source == source)
                    || add_supports.iter().any(|s: &SupportLink| s.fact_version_id == target_version_id && s.source == source);
                if !exists {
                    add_supports.push(SupportLink {
                        support_link_id: generated_id("support", &json!([request.library_id, target_version_id, source])),
                        fact_version_id: target_version_id, source, system: None });
                }
            }
        }
    }
    for key in &recalculate { recompute_group(&mut working, key, &mut warnings); }
    let mut new_versions = vec![];
    let mut close_versions = vec![];
    for (id, mut version) in working {
        let mut carry_sources = vec![];
        if let Some(old) = originals.get(&id) {
            let changed = version.content != old.content || version.asserted_valid_time != old.asserted_valid_time
                || version.valid_time != old.valid_time || version.state_group != old.state_group
                || version.sources != old.sources || version.derivation != old.derivation;
            if !changed { continue; }
            if version.content == old.content && version.asserted_valid_time == old.asserted_valid_time
                && version.sources == old.sources && version.state_group == old.state_group {
                carry_sources.extend(request.base.support_links.iter()
                    .filter(|s| s.fact_version_id == old.fact_version_id).map(|s| s.source.clone()));
            }
            version.supersedes = Some(old.fact_version_id.clone());
            if version.update_reason == old.update_reason { version.update_reason = "RECOMPUTE_STATE_TIMELINE".into(); }
            close_versions.push(CloseVersion { fact_version_id: old.fact_version_id.clone(), reason: version.update_reason.clone(), basis: None });
        }
        version.system = None;
        version.fact_version_id = generated_id("fv", &json!([request.library_id, request.request_id, version]));
        for source in carry_sources {
            add_supports.push(SupportLink {
                support_link_id: generated_id("support", &json!([request.library_id, version.fact_version_id, source])),
                fact_version_id: version.fact_version_id.clone(), source, system: None });
        }
        new_versions.push(version);
    }
    for (fact_version_id, (reason, basis)) in withdrawal {
        close_versions.push(CloseVersion { fact_version_id, reason, basis: Some(basis) });
    }
    // Supporting an exact version that this batch also supersedes would be immediately invisible.
    if add_supports.iter().any(|s| close_versions.iter().any(|c| c.fact_version_id == s.fact_version_id)) {
        return Err(bad("TEMPORAL_SUPPORT_TARGET_SUPERSEDED", "Add support in a separate batch after correction/withdrawal"));
    }
    new_versions.sort_by(|a,b| a.fact_id.cmp(&b.fact_id));
    close_versions.sort_by(|a,b| a.fact_version_id.cmp(&b.fact_version_id));
    add_supports.sort_by(|a,b| a.support_link_id.cmp(&b.support_link_id));
    let affected_group_digests = affected.into_iter().map(|key| GroupDigest { digest: group_digest(&request.base, &key), key }).collect();
    Ok(ChangeSet { request_id: request.request_id, library_id: request.library_id,
        base_head: request.base.head.clone(), base_digest: base_digest(&request.base), affected_group_digests,
        new_versions, close_versions, add_supports, warnings })
}

#[derive(PartialEq)]
enum Match { Supported, Possible, Excluded }
fn interval_match(start: Option<&TimePoint>, end: Option<&TimePoint>, open_as_reported: bool, at: DateTime<Utc>) -> (Match, &'static str) {
    let start = start.and_then(point_bounds);
    let end = end.and_then(point_bounds);
    if start.is_some_and(|(earliest, _)| at < earliest) { return (Match::Excluded, "BEFORE_INTERVAL_START"); }
    if end.is_some_and(|(_, latest)| at >= latest) { return (Match::Excluded, "AT_OR_AFTER_INTERVAL_END"); }
    let definite_start = start.is_some_and(|(_, latest)| at >= latest);
    let definite_end = end.is_some_and(|(earliest, _)| at < earliest) || open_as_reported;
    if definite_start && definite_end { (Match::Supported, "WITHIN_ALL_COMPATIBLE_INTERVALS") }
    else { (Match::Possible, "INTERVAL_BOUNDARY_UNRESOLVED") }
}
fn world_match(time: &WorldTime, at: &TimePoint) -> (Match, &'static str) {
    let Some(at) = exact(at) else { return (Match::Possible, "QUERY_TIME_UNRESOLVED"); };
    match time {
        WorldTime::Timeless { .. } => (Match::Supported, "TIMELESS_EXPLICIT"),
        WorldTime::Unknown { .. } => (Match::Possible, "WORLD_TIME_UNKNOWN"),
        WorldTime::Event { occurred_at } => match exact(occurred_at) {
            Some(t) if t == at => (Match::Supported, "EVENT_AT_INSTANT"),
            Some(_) => (Match::Excluded, "EVENT_OTHER_INSTANT"),
            None => {
                if let Some((earliest, latest)) = point_bounds(occurred_at) {
                    if at < earliest || at >= latest { return (Match::Excluded, "EVENT_OUTSIDE_PRECISION_RANGE"); }
                }
                (Match::Possible, "EVENT_TIME_UNRESOLVED")
            }
        },
        WorldTime::Window { start, end } => interval_match(Some(start), Some(end), false, at),
        WorldTime::State { start, end } => {
            match end {
                TimeEnd::Exact { point } => interval_match(start.as_ref(), Some(point), false, at),
                TimeEnd::OpenAsReported => interval_match(start.as_ref(), None, true, at),
                TimeEnd::Unknown => interval_match(start.as_ref(), None, false, at),
            }
        }
    }
}
pub fn select_fact_versions(mut request: SelectRequest) -> Result<Selection> {
    if let Some(at) = &mut request.at { normalize_point(at, &mut vec![]); }
    let mut result = Selection::default();
    let mut selected_ids = BTreeSet::new();
    for mut version in request.versions {
        let system = version.system.as_ref().ok_or_else(|| bad("TEMPORAL_READ_UNADOPTED", "Read version has no committed system interval"))?;
        validate_system(system)?;
        if !system_visible(system, request.selected_seq) { continue; }
        // A fixed historical ReadView must not reveal a later ledger closure.
        // Only this owned read projection changes; the caller's durable interval is retained.
        if system.to_seq.is_some_and(|to| to > request.selected_seq) {
            let projection = version.system.as_mut().unwrap();
            projection.to_seq = None;
            projection.recorded_to = None;
        }
        if !selected_ids.insert(version.fact_id.clone()) { return Err(bad("TEMPORAL_READ_DUPLICATE_CHAIN", "Multiple visible versions of one fact chain")); }
        let mut sources = version.sources.clone();
        for link in &request.support_links {
            if link.fact_version_id != version.fact_version_id { continue; }
            let system = link.system.as_ref().ok_or_else(|| bad("TEMPORAL_READ_UNADOPTED", "Read support has no committed interval"))?;
            validate_system(system)?;
            if system_visible(system, request.selected_seq) && !sources.contains(&link.source) { sources.push(link.source.clone()); }
        }
        let (status, reason) = request.at.as_ref().map(|at| world_match(&version.valid_time, at)).unwrap_or((Match::Supported, "WORLD_TIME_NOT_FILTERED"));
        let selected = SelectedFact { fact: version, sources, reasons: vec![reason.into()] };
        match status { Match::Supported => result.supported.push(selected), Match::Possible => result.possible.push(selected), Match::Excluded => result.excluded.push(selected) }
    }
    for group in [&mut result.supported, &mut result.possible, &mut result.excluded] { group.sort_by(|a,b| a.fact.fact_version_id.cmp(&b.fact.fact_version_id)); }
    Ok(result)
}
fn decode<T: for<'a> Deserialize<'a>>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|e| bad("TEMPORAL_INPUT_INVALID", e.to_string()))
}
fn encode<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| bad("TEMPORAL_SERIALIZATION_FAILED", e.to_string()))
}
pub fn execute(operation: &str, payload: &Value) -> Result<Value> {
    match operation {
        "normalize_time" => encode(normalize_time(decode(payload)?)?),
        "prepare_change_set" => encode(prepare_change_set(decode(payload)?)?),
        "select_fact_versions" => encode(select_fact_versions(decode(payload)?)?),
        _ => Err(bad("CORE_OPERATION_UNKNOWN", operation)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_offsets_are_resolved_only_in_rust_and_keep_legacy_shape() {
        for (value,precision,zone,expected,warning) in [
            ("2026-09-01T09:00:00",Precision::Exact,"UTC+08:00",Some("2026-09-01T01:00:00Z"),None),
            ("2026-09-01T09:00:00+08:00",Precision::Exact,"GMT+08:00",Some("2026-09-01T01:00:00Z"),None),
            ("2026-09-01T09:00:00Z",Precision::Exact,"-00:00",Some("2026-09-01T09:00:00Z"),None),
            ("2026-09-01T09:00",Precision::Minute,"+08:00",Some("2026-09-01T01:00:00Z"),Some("TIME_MINUTE_PRECISION")),
            ("2026-09-01T09:00:00+08:00",Precision::Exact,"+09:00",None,Some("TIMEZONE_CONFLICT")),
            ("2026-09-01T09:00:00",Precision::Exact,"Asia/Shanghai",None,Some("TIMEZONE_UNSUPPORTED")),
        ] {
            let point = TimePoint {value:Some(value.into()),precision,raw:None,basis:Some("source".into())};
            let result = normalize_time(NormalizeRequest {times:vec![WorldTime::Event {occurred_at:point}],
                timezone_hints:vec![TimezoneHint {time_index:0,point:"OCCURRED_AT".into(),timezone:zone.into()}]}).unwrap();
            let WorldTime::Event {occurred_at:point} = &result.times[0] else {panic!()};
            if let Some(expected) = expected {assert_eq!(point.value.as_deref(),Some(expected));}
            else {assert_eq!(point.precision,Precision::Unknown); assert_eq!(point.value.as_deref(),Some(value));}
            assert_eq!(point.raw.as_deref(),Some(value));
            if let Some(code) = warning {assert!(result.warnings.iter().any(|w|w.code==code));}
            else {assert!(result.warnings.is_empty());}
            assert_eq!(serde_json::to_value(point).unwrap().as_object().unwrap().len(),4);
        }
        let legacy = json!({"times":[{"kind":"EVENT","occurred_at":{"value":"2026-09-01T09:00:00Z","precision":"EXACT","raw":null,"basis":null}}]});
        let decoded:NormalizeRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(),legacy);
    }
    fn pt(day: u32) -> TimePoint { point_at(format!("2026-05-{day:02}T00:00:00Z"), "SOURCE_EXPLICIT".into()) }
    fn source(id: &str, kind: SourceKind) -> SourceRef {
        SourceRef { source_version_id: id.into(), kind, role: SourceRole::Support, quote: Some(format!("source {id}")) }
    }
    fn state(value: &str, day: u32) -> FactAssertion {
        FactAssertion { content: FactContent { subject_ref: "project:1".into(), predicate: "owner".into(),
            value: json!(value), conditions: json!({"role":"lead"}), negated: false, modality: asserted() },
            valid_time: WorldTime::State { start: Some(pt(day)), end: TimeEnd::OpenAsReported },
            state_group: Some(StateGroup { key: "project:1/owner/lead".into(), single_valued: true }),
            sources: vec![source(&format!("doc:{value}:{day}"), SourceKind::Document)] }
    }
    fn add(assertion: FactAssertion) -> Update { Update::AddFact { assertion, reason: "new statement".into() } }
    fn change(assertion: FactAssertion) -> Update {
        Update::StateChange { assertion, authority: Some(SuccessionAuthority::OntologySingleValue), reason: "handover".into() }
    }
    #[derive(Default)]
    struct Fixture { seq: u64, all: Vec<FactVersion>, links: Vec<SupportLink> }
    impl Fixture {
        fn base(&self) -> Base {
            let versions: Vec<_> = self.all.iter().filter(|v| system_visible(v.system.as_ref().unwrap(), self.seq)).cloned().collect();
            let ids: BTreeSet<_> = versions.iter().map(|v| v.fact_version_id.clone()).collect();
            Base { head: Head { activation_seq: self.seq, activation_ref: if self.seq == 0 { None } else { Some(format!("S{}", self.seq)) } },
                versions, support_links: self.links.iter().filter(|s| ids.contains(s.fact_version_id.as_str()) && system_visible(s.system.as_ref().unwrap(), self.seq)).cloned().collect() }
        }
        fn plan(&self, updates: Vec<Update>) -> ChangeSet {
            prepare_change_set(PrepareRequest { request_id: format!("request:{}", self.seq + 1), library_id: "fixture".into(), base: self.base(), updates }).unwrap()
        }
        fn commit(&mut self, plan: ChangeSet) {
            self.seq += 1;
            let timestamp = format!("2026-06-{:02}T00:00:00Z", self.seq);
            for close in plan.close_versions {
                let system = self.all.iter_mut().find(|v| v.fact_version_id == close.fact_version_id).unwrap().system.as_mut().unwrap();
                system.to_seq = Some(self.seq); system.recorded_to = Some(timestamp.clone());
            }
            let system = SystemInterval { from_seq: self.seq, to_seq: None, recorded_from: timestamp, recorded_to: None };
            for mut version in plan.new_versions { version.system = Some(system.clone()); self.all.push(version); }
            for mut link in plan.add_supports { link.system = Some(system.clone()); self.links.push(link); }
        }
        fn publish(&mut self, updates: Vec<Update>) -> ChangeSet { let plan = self.plan(updates); self.commit(plan.clone()); plan }
        fn current(&self, value: &str) -> FactVersion {
            self.base().versions.into_iter().find(|v| v.content.value == json!(value)).unwrap()
        }
        fn read(&self, seq: u64, day: Option<u32>) -> Selection {
            select_fact_versions(SelectRequest { selected_seq: seq, at: day.map(pt), versions: self.all.clone(), support_links: self.links.clone() }).unwrap()
        }
    }
    fn supported_values(selection: &Selection) -> Vec<String> {
        let mut values: Vec<_> = selection.supported.iter().map(|v| v.fact.content.value.as_str().unwrap().to_owned()).collect(); values.sort(); values
    }
    fn end_day(fact: &FactVersion) -> Option<u32> {
        match &fact.valid_time { WorldTime::State { end: TimeEnd::Exact { point }, .. } => Some(exact(point).unwrap().format("%d").to_string().parse().unwrap()), _ => None }
    }
    #[test]
    fn k1_first_exact_time_and_half_open_interval() {
        let mut f = Fixture::default();
        let mut a = state("A", 1);
        a.valid_time = WorldTime::State { start: Some(TimePoint { value: Some("2026-05-01T08:00:00+08:00".into()), precision: Precision::Exact, raw: None, basis: None }),
            end: TimeEnd::Exact { point: pt(8) } };
        f.publish(vec![add(a)]);
        assert_eq!(supported_values(&f.read(1, Some(1))), vec!["A"]);
        assert!(f.read(1, Some(8)).supported.is_empty());
        assert_eq!(f.read(1, Some(8)).excluded.len(), 1);
        let WorldTime::State { start: Some(start), .. } = f.current("A").valid_time else { panic!() };
        assert_eq!(start.value.as_deref(), Some("2026-05-01T00:00:00Z"));
        assert_eq!(start.raw.as_deref(), Some("2026-05-01T08:00:00+08:00"));
        assert!(f.all[0].system.is_some());
    }
    #[test]
    fn k1_late_arrival_same_current_world_timeline() {
        let mut normal = Fixture::default();
        normal.publish(vec![add(state("A", 1))]); normal.publish(vec![change(state("B", 8))]);
        let mut late = Fixture::default();
        late.publish(vec![change(state("B", 8))]); late.publish(vec![add(state("A", 1))]);
        for f in [&normal, &late] {
            assert_eq!(end_day(&f.current("A")), Some(8));
            assert_eq!(supported_values(&f.read(2, Some(7))), vec!["A"]);
            assert_eq!(supported_values(&f.read(2, Some(8))), vec!["B"]);
        }
        assert_eq!(normal.all.len(), 3); assert_eq!(late.all.len(), 2);
    }
    #[test]
    fn k1_unique_state_succession_and_no_default_uniqueness() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]);
        let old = f.current("A"); let plan = f.publish(vec![change(state("B", 8))]);
        assert_eq!(plan.new_versions.len(), 2); assert_eq!(plan.close_versions.len(), 1);
        let a = f.current("A"); let b = f.current("B");
        assert_ne!(a.fact_id, b.fact_id); assert_eq!(a.supersedes, Some(old.fact_version_id));
        assert_eq!(a.derivation.as_ref().unwrap().successor_fact_id, b.fact_id);
        assert!(matches!(a.asserted_valid_time, WorldTime::State { end: TimeEnd::OpenAsReported, .. }));
        let mut independent = Fixture::default(); let mut x = state("X", 1); x.state_group.as_mut().unwrap().single_valued = false;
        let mut y = state("Y", 8); y.state_group.as_mut().unwrap().single_valued = false;
        independent.publish(vec![add(x)]);
        let plan = independent.publish(vec![Update::StateChange { assertion: y, authority: None, reason: "unconfirmed change".into() }]);
        assert!(plan.close_versions.is_empty()); assert_eq!(supported_values(&independent.read(2, Some(9))), vec!["X", "Y"]);
    }
    #[test]
    fn k1_correction_recomputes_only_changed_facts_and_four_reads() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]); f.publish(vec![change(state("B", 8))]);
        let b = f.current("B"); let mut revision = state("B", 10);
        revision.sources = vec![source("human:correction:1", SourceKind::HumanRevision)];
        let plan = f.publish(vec![Update::Correct { target_version_id: b.fact_version_id.clone(), assertion: revision, reason: "start was May 10".into() }]);
        assert_eq!(plan.new_versions.len(), 2); assert_eq!(plan.close_versions.len(), 2);
        assert_eq!(end_day(&f.current("A")), Some(10)); assert_eq!(f.current("B").fact_id, b.fact_id);
        for (seq, day, expected) in [(1,9,"A"),(2,9,"B"),(3,9,"A"),(3,11,"B")] {
            assert_eq!(supported_values(&f.read(seq, Some(day))), vec![expected]);
        }
        let corrected = f.current("B");
        assert_eq!(corrected.sources.iter().filter(|s| s.role == SourceRole::Support).count(), 1);
        assert!(corrected.sources.iter().any(|s| s.source_version_id == b.sources[0].source_version_id && s.role == SourceRole::Background));
        let mut value_revision = state("B-new-name", 10); value_revision.sources = vec![source("human:correction:2", SourceKind::HumanRevision)];
        let only_b = f.publish(vec![Update::Correct { target_version_id: corrected.fact_version_id, assertion: value_revision, reason: "name correction".into() }]);
        assert_eq!(only_b.new_versions.len(), 1); assert_eq!(only_b.close_versions.len(), 1);
        assert_eq!(f.all.len(), 6);
    }
    #[test]
    fn k1_independent_observations_and_disagreement_coexist() {
        let mut f = Fixture::default();
        f.publish(vec![add(state("A", 1)), add(state("B", 8))]);
        assert_eq!(supported_values(&f.read(1, Some(9))), vec!["A", "B"]);
        let b = f.current("B"); let mut corrected = state("B-corrected", 8);
        corrected.sources = vec![source("human:independent-revision", SourceKind::HumanRevision)];
        let plan = f.publish(vec![Update::Correct { target_version_id: b.fact_version_id, assertion: corrected, reason: "independent correction".into() }]);
        assert_eq!(plan.close_versions.len(), 1); assert_eq!(end_day(&f.current("A")), None);
        let mut obs1 = state("measurement:1", 9); obs1.state_group = None; obs1.valid_time = WorldTime::Event { occurred_at: pt(9) };
        let mut obs2 = obs1.clone(); obs2.content.value = json!("measurement:2");
        let plan = f.publish(vec![add(obs1), add(obs2)]);
        assert!(plan.close_versions.is_empty()); assert_eq!(plan.new_versions.len(), 2);
        assert_eq!(f.read(3, Some(9)).supported.len(), 4);
        assert_eq!(f.read(3, Some(10)).excluded.len(), 2);
    }
    #[test]
    fn k1_unknown_and_coarse_never_become_definite_instants() {
        let mut f = Fixture::default();
        let mut unknown_end = state("unknown-end", 1); unknown_end.state_group = None;
        unknown_end.valid_time = WorldTime::State { start: Some(pt(1)), end: TimeEnd::Unknown };
        let mut coarse = state("coarse-event", 1); coarse.state_group = None;
        coarse.valid_time = WorldTime::Event { occurred_at: TimePoint { value: Some("2026-05".into()), precision: Precision::Month, raw: None, basis: None } };
        let mut no_tz = state("local-time", 1); no_tz.state_group = None;
        no_tz.valid_time = WorldTime::Event { occurred_at: TimePoint { value: Some("2026-05-09T00:00:00".into()), precision: Precision::Exact, raw: None, basis: None } };
        let mut unknown = state("unknown", 1); unknown.state_group = None;
        unknown.valid_time = WorldTime::Unknown { raw: Some("previously".into()), basis: None };
        let plan = f.publish(vec![add(unknown_end),add(coarse),add(no_tz),add(unknown)]);
        assert!(plan.warnings.iter().any(|w| w.code == "TIMEZONE_UNKNOWN"));
        let result = f.read(1, Some(9)); assert_eq!(result.possible.len(), 4); assert!(result.supported.is_empty());
        assert_eq!(f.read(1, None).supported.len(), 4);
    }
    #[test]
    fn boundary_withdrawal_recomputes_derived_end_without_inventing_world_end() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]); f.publish(vec![change(state("B", 8))]);
        let b = f.current("B"); let plan = f.publish(vec![Update::Withdraw { target_version_id: b.fact_version_id.clone(),
            basis: source("human:withdrawal", SourceKind::HumanRevision), reason: "unsupported assertion".into() }]);
        assert_eq!(plan.close_versions.len(), 2); assert_eq!(plan.new_versions.len(), 1);
        assert!(matches!(f.current("A").valid_time, WorldTime::State { end: TimeEnd::OpenAsReported, .. }));
        assert_eq!(supported_values(&f.read(3, Some(9))), vec!["A"]);
        let old_b = f.all.iter().find(|v| v.fact_version_id == b.fact_version_id).unwrap();
        assert!(matches!(old_b.valid_time, WorldTime::State { end: TimeEnd::OpenAsReported, .. }));
        assert_eq!(supported_values(&f.read(2, Some(9))), vec!["B"]);
    }
    #[test]
    fn boundary_add_support_has_own_historical_visibility_and_no_rebirth() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]); let old = f.current("A");
        let source = source("doc:later-support", SourceKind::Document);
        let plan = f.publish(vec![Update::AddSupport { target_version_id: old.fact_version_id.clone(), source: source.clone(), reason: "corroboration".into() }]);
        assert!(plan.new_versions.is_empty()); assert!(plan.close_versions.is_empty()); assert_eq!(plan.add_supports.len(), 1);
        assert_eq!(f.read(1, Some(9)).supported[0].sources.len(), 1);
        assert_eq!(f.read(2, Some(9)).supported[0].sources.len(), 2);
        assert_eq!(f.current("A").system.unwrap().from_seq, 1);
        let duplicate = f.plan(vec![Update::AddSupport { target_version_id: old.fact_version_id, source, reason: "already known".into() }]);
        assert!(duplicate.add_supports.is_empty());
    }
    #[test]
    fn boundary_added_support_carries_only_over_derived_end_revision() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]); let a1 = f.current("A");
        let extra = source("doc:extra-predecessor", SourceKind::Document);
        f.publish(vec![Update::AddSupport { target_version_id: a1.fact_version_id, source: extra.clone(), reason: "corroboration".into() }]);
        let plan = f.publish(vec![change(state("B", 8))]);
        assert_eq!(plan.add_supports.len(), 1);
        assert_eq!(plan.add_supports[0].fact_version_id, f.current("A").fact_version_id);
        assert_eq!(f.read(1, Some(7)).supported[0].sources.len(), 1);
        assert_eq!(f.read(2, Some(7)).supported[0].sources.len(), 2);
        assert_eq!(f.read(3, Some(7)).supported[0].sources.len(), 2);
        assert_eq!(f.links.iter().filter(|s| s.source == extra).map(|s| s.system.as_ref().unwrap().from_seq).collect::<Vec<_>>(), vec![2,3]);
        let a = f.current("A"); let mut revision = state("A-renamed", 1);
        revision.sources = vec![source("human:rename-a", SourceKind::HumanRevision)];
        let plan = f.publish(vec![Update::Correct { target_version_id: a.fact_version_id, assertion: revision, reason: "correct value".into() }]);
        assert!(plan.add_supports.is_empty());
        let selected = f.read(4, Some(7));
        assert!(selected.supported[0].sources.iter().any(|s| s.source_version_id == extra.source_version_id && s.role == SourceRole::Background));
    }
    #[test]
    fn boundary_fixed_old_read_view_hides_future_system_closure() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]);
        let original_id = f.current("A").fact_version_id;
        let s1_before = serde_json::to_value(f.read(1, Some(9))).unwrap();
        f.publish(vec![change(state("B", 8))]);
        let s1_after = serde_json::to_value(f.read(1, Some(9))).unwrap();
        assert_eq!(s1_before, s1_after);
        let durable = f.all.iter().find(|v| v.fact_version_id == original_id).unwrap().system.as_ref().unwrap();
        assert_eq!(durable.to_seq, Some(2));
        assert_eq!(durable.recorded_to.as_deref(), Some("2026-06-02T00:00:00Z"));
        assert_eq!(supported_values(&f.read(2, Some(9))), vec!["B"]);
    }
    #[test]
    fn boundary_source_explicit_end_never_extends_on_successor_correction() {
        let mut f = Fixture::default(); let mut a = state("A", 1);
        a.valid_time = WorldTime::State { start: Some(pt(1)), end: TimeEnd::Exact { point: pt(9) } };
        f.publish(vec![add(a)]); f.publish(vec![change(state("B", 8))]); assert_eq!(end_day(&f.current("A")), Some(8));
        let b = f.current("B"); let mut revision = state("B", 10); revision.sources = vec![source("human:endcap", SourceKind::HumanRevision)];
        let plan = f.publish(vec![Update::Correct { target_version_id: b.fact_version_id, assertion: revision, reason: "later handover".into() }]);
        assert_eq!(end_day(&f.current("A")), Some(9)); assert!(f.current("A").derivation.is_none());
        assert!(plan.warnings.iter().any(|w| w.code == "STATE_TIMELINE_GAP"));
        assert!(f.read(3, Some(9)).supported.is_empty());
    }
    #[test]
    fn boundary_tied_state_starts_do_not_let_id_order_choose_tenure() {
        let mut f = Fixture::default();
        let plan = f.publish(vec![change(state("B", 8)), change(state("C", 8)), change(state("D", 10))]);
        assert!(plan.warnings.iter().any(|w| w.code == "STATE_START_CONFLICT"));
        assert_eq!(end_day(&f.current("B")), Some(10)); assert_eq!(end_day(&f.current("C")), Some(10));
        assert_eq!(supported_values(&f.read(1, Some(9))), vec!["B", "C"]);
        assert_eq!(supported_values(&f.read(1, Some(10))), vec!["D"]);
    }
    #[test]
    fn boundary_invalid_targets_sources_and_model_system_fields_are_rejected() {
        let mut f = Fixture::default(); f.publish(vec![add(state("A", 1))]);
        let old = f.current("A");
        let mut request = PrepareRequest { request_id: "invalid".into(), library_id: "fixture".into(), base: f.base(),
            updates: vec![Update::Correct { target_version_id: old.fact_version_id.clone(), assertion: state("A", 2), reason: "bad evidence".into() }] };
        assert_eq!(prepare_change_set(request.clone()).unwrap_err().code, "TEMPORAL_CORRECTION_BASIS_REQUIRED");
        request.updates = vec![Update::Withdraw { target_version_id: "stale".into(), basis: source("human:w", SourceKind::HumanRevision), reason: "bad target".into() }];
        assert_eq!(prepare_change_set(request.clone()).unwrap_err().code, "TEMPORAL_TARGET_NOT_CURRENT");
        let mut value = serde_json::to_value(&request).unwrap();
        value["updates"][0]["system"] = json!({"from_seq": 99});
        assert_eq!(execute("prepare_change_set", &value).unwrap_err().code, "TEMPORAL_INPUT_INVALID");
        let plan1 = f.plan(vec![add(state("B", 8))]); let plan2 = f.plan(vec![add(state("B", 8))]);
        assert_eq!(serde_json::to_value(plan1).unwrap(), serde_json::to_value(plan2).unwrap());
    }
    #[test]
    fn boundary_offset_equivalence_invalid_dates_and_clock_regression() {
        let p = TimePoint { value: Some("2026-05-01T08:00:00+08:00".into()), precision: Precision::Exact, raw: None, basis: None };
        assert_eq!(exact(&p), exact(&pt(1)));
        let mut invalid = TimePoint { value: Some("2026-02-30T00:00:00Z".into()), precision: Precision::Exact, raw: None, basis: None };
        let mut warnings = vec![]; normalize_point(&mut invalid, &mut warnings);
        assert_eq!(invalid.precision, Precision::Unknown); assert_eq!(warnings[0].code, "TIME_INVALID");
        let system = SystemInterval { from_seq: 1, to_seq: Some(2), recorded_from: "2026-06-02T00:00:00Z".into(), recorded_to: Some("2026-06-01T00:00:00Z".into()) };
        assert_eq!(validate_system(&system).unwrap_err().code, "TEMPORAL_SYSTEM_TIME_INVALID");
    }
    #[test]
    fn window_minute_precision_is_finite_with_uncertain_boundary_minutes() {
        let minute = |value: &str| TimePoint { value: Some(value.into()), precision: Precision::Minute, raw: None, basis: Some("aggregate observation window".into()) };
        let raw = WorldTime::Window { start: minute("2026-05-01T09:00+08:00"), end: minute("2026-05-01T09:05+08:00") };
        let normalized = normalize_time(NormalizeRequest { times: vec![raw], timezone_hints:vec![] }).unwrap();
        let window = &normalized.times[0];
        let WorldTime::Window { start, end } = window else { panic!() };
        assert_eq!(start.precision, Precision::Minute); assert_eq!(end.precision, Precision::Minute);
        assert_eq!(start.raw.as_deref(), Some("2026-05-01T09:00+08:00"));
        assert_eq!(start.value.as_deref(), Some("2026-05-01T01:00:00Z"));
        for (at, expected) in [("08:59:59",Match::Excluded),("09:00:00",Match::Possible),
            ("09:00:59",Match::Possible),("09:01:00",Match::Supported),("09:04:59",Match::Supported),
            ("09:05:00",Match::Possible),("09:05:59",Match::Possible),("09:06:00",Match::Excluded)] {
            let at = TimePoint { value: Some(format!("2026-05-01T{at}+08:00")), precision: Precision::Exact, raw: None, basis: None };
            assert!(world_match(window, &at).0 == expected, "unexpected minute window result at {:?}", at.value);
        }
        let mut local = WorldTime::Window { start: minute("2026-05-01T09:00"), end: minute("2026-05-01T09:05") };
        normalize_world(&mut local, &mut vec![]).unwrap();
        assert!(world_match(&local, &pt(1)).0 == Match::Possible);
        let exact_window = WorldTime::Window { start: pt(1), end: pt(2) };
        assert!(world_match(&exact_window, &pt(1)).0 == Match::Supported);
        assert!(world_match(&exact_window, &pt(2)).0 == Match::Excluded);
        let mut f = Fixture::default(); let mut assertion = state("window-measurement", 1);
        assertion.valid_time = window.clone();
        let plan = f.publish(vec![change(assertion), change(state("later-state", 10))]);
        assert!(plan.warnings.iter().any(|w| w.code == "STATE_START_UNRESOLVED"));
        assert!(f.current("window-measurement").derivation.is_none());
        assert_eq!(&f.current("window-measurement").valid_time, window);
    }
}
