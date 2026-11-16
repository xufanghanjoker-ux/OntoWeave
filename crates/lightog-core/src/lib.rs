//! Unified deterministic compatibility kernel. Model, transport and storage remain adapters.
pub mod answer;
pub mod adopted_context;
pub mod capability;
pub mod common;
pub mod temporal_core_v1;
pub mod cq_compiler;
pub mod demand;
pub mod evidence;
pub mod evidence_routing;
pub mod extraction_menu;
pub mod governance;
pub mod knowledge_build;
pub mod hybrid_retrieval;
pub mod native_query_v1;
pub mod native_query_search_v1;
pub mod native_query_graph_v1;
pub mod native_query_compute_v1;
pub mod learning;
pub mod model;
pub mod model_json_boundary;
pub mod retrieval;
pub mod review;
pub mod rpc;
pub mod semantic_review;
pub mod semantic_review_v2;
pub mod semantic_review_v3;
pub mod semantic_review_v4;
pub mod provider_schema_v1;
pub mod support_selection;
pub mod source_support_gap;
pub mod source_support_gap_v2;
pub mod source_gap_state;
pub mod source_gap_state_v2;
pub mod source_gap_state_v3;
pub mod source_answer;
pub mod fine_source_evidence;
pub mod p5_learning_store;
pub mod source_learning_v1;
pub mod seed_materialize;
pub mod structure;

pub mod source_answer_budget_v1;

pub mod candidate_staging_v1;
pub mod incremental_graph_v1;

pub mod source_execution_v1;
pub mod source_human_review_v1;

pub mod source_correction_v1;

pub mod source_proposal_replay_v1;

pub mod candidate_recovery_v1;
pub mod document_scope_v1;
pub mod document_scope_coverage_v1;
pub mod document_family_route_v1;
pub mod document_family_normalize_v1;
