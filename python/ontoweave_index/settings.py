"""Explicit deployment configuration for the shared retrieval clients."""
from os import environ

from ontoweave_publication.runtime import _credential
from ontoweave_publication.store import require

from .embedding import ManagedEmbeddingClient
from .reranker import ManagedReranker


def index_settings(config, *, credential_resolver=None):
    if config is None:
        return None, None
    require(isinstance(config, dict) and set(config) <= {"segment_codepoints", "embedding"}
            and type(config.get("segment_codepoints")) is int and config["segment_codepoints"] > 0,
            "INDEX_RUNTIME_CONFIG_INVALID", 422)
    embedding = config.get("embedding")
    if embedding is None:
        return config["segment_codepoints"], None
    require(isinstance(embedding, dict) and set(embedding) <= {
        "credential_file_env", "credential_env", "protocol", "endpoint_mode", "base_url", "provider_identity",
        "model", "model_revision", "dimensions", "max_input_utf8_bytes", "max_batch_utf8_bytes",
        "response_evidence_directory"}
        and bool(embedding.get("credential_file_env")) != bool(embedding.get("credential_env")),
        "INDEX_EMBEDDING_CONFIG_INVALID", 422)
    return config["segment_codepoints"], ManagedEmbeddingClient(
        embedding, credential=credential_resolver or managed_credential(embedding),
        evidence_directory=embedding.get("response_evidence_directory") or environ.get("ONTOWEAVE_EMBEDDING_EVIDENCE_DIR"))


def managed_credential(config):
    require(bool(config.get("credential_file_env")) != bool(config.get("credential_env")),
            "MODEL_CREDENTIAL_BINDING_REQUIRED", 422)
    path = environ.get(config["credential_file_env"]) if "credential_file_env" in config else None
    return _credential(config.get("credential_env"), path)


def query_reranker(store, library, config):
    if config is None:
        return None
    require(isinstance(config, dict) and set(config) <= {
        "credential_file_env", "credential_env", "protocol", "endpoint_mode", "base_url",
        "provider_identity", "model", "model_revision"}, "QUERY_RERANK_CONFIG_INVALID", 422)
    return ManagedReranker(store, library, config, credential=managed_credential(config))
