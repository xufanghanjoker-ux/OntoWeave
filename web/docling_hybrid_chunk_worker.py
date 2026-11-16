"""Chunk retained Docling JSON locally; no document parsing or model calls.

The text is serialized by Docling HybridChunker. Source item references, rather
than invented offsets in an earlier Markdown serialization, identify its origin.
"""
import hashlib
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path


def fail(code):
    raise ValueError(code)


def local_only(event, args):
    if event.startswith("socket.") or event.startswith("subprocess.") or event in {
        "os.system", "os.exec", "os.posix_spawn", "os.posix_spawnp"
    }:
        raise PermissionError("HYBRID_CHUNK_NETWORK_FORBIDDEN")


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def convert(request_path, target):
    import tiktoken
    from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
    from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
    from docling_core.types.doc import DoclingDocument, SectionHeaderItem, TitleItem

    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    budget = request["max_tokens"]
    if not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
        fail("HYBRID_CHUNK_BUDGET_INVALID")
    if request["tokenizer_name"] != "cl100k_base":
        fail("HYBRID_CHUNK_TOKENIZER_UNSUPPORTED")
    # Installation/prefetch is explicit. Ordinary product chunking cannot
    # download resources, fetch linked document content, or invoke subprocesses.
    sys.addaudithook(local_only)
    try:
        encoding = tiktoken.get_encoding(request["tokenizer_name"])
    except PermissionError:
        fail("HYBRID_CHUNK_TOKENIZER_DATA_MISSING")
    tokenizer = OpenAITokenizer(tokenizer=encoding, max_tokens=budget)
    chunker = HybridChunker(tokenizer=tokenizer, merge_peers=True,
                            repeat_table_header=True, always_emit_headings=True)
    dependencies = {name: version(name) for name in ("docling", "docling-core", "tiktoken", "semchunk")}
    cache = Path(os.environ["TIKTOKEN_CACHE_DIR"])
    cache_hashes = sorted(sha_bytes(p.read_bytes()) for p in cache.iterdir() if p.is_file())
    result = {"versions": dependencies, "tokenizer_data_sha256": cache_hashes, "documents": []}
    for source in request["documents"]:
        raw_bytes = Path(source["raw_path"]).read_bytes()
        if sha_bytes(raw_bytes) != source["raw_sha256"]:
            fail("HYBRID_CHUNK_RAW_SOURCE_CHANGED")
        raw = json.loads(raw_bytes)
        doc = DoclingDocument.model_validate(raw["document"])
        items = {item.self_ref: item for item, _ in doc.iterate_items(with_groups=True)}
        paths, headings = {}, {}
        for item, _ in doc.iterate_items(with_groups=True):
            if isinstance(item, (TitleItem, SectionHeaderItem)):
                level = item.level if isinstance(item, SectionHeaderItem) else 0
                headings = {key: value for key, value in headings.items() if key < level}
                headings[level] = item.self_ref
            paths[item.self_ref] = list(headings.values())

        def source_item(item, role):
            parents, current = [], item
            while getattr(current, "parent", None):
                ref = current.parent.cref
                if ref in parents:
                    fail("HYBRID_CHUNK_SOURCE_PARENT_CYCLE")
                parents.append(ref)
                current = items.get(ref)
                if current is None:
                    break
            return {"self_ref": item.self_ref, "label": item.label.value,
                    "parent_refs": parents, "role": role,
                    "provenance": [p.model_dump(mode="json") for p in getattr(item, "prov", [])]}

        chunks = []
        for ordinal, chunk in enumerate(chunker.chunk(dl_doc=doc)):
            text = chunk.text
            contextualized = chunker.contextualize(chunk=chunk)
            token_count = len(encoding.encode(contextualized))
            refs = {}
            for item in chunk.meta.doc_items:
                refs[item.self_ref] = source_item(item, "CORE")
                for ref in paths.get(item.self_ref, []):
                    if ref not in refs and ref in items:
                        refs[ref] = source_item(items[ref], "CONTEXT")
            # Even a heading-only section retains its actual item reference.
            status = "PLANNED" if token_count <= budget else "GAP"
            chunks.append({"ordinal": ordinal, "text": text,
                           "contextualized_text": contextualized,
                           "token_count": token_count,
                           "headings": chunk.meta.headings or [],
                           "source_items": list(refs.values()),
                           "status": status,
                           "warnings": [] if status == "PLANNED" else ["HYBRID_CHUNK_OUTPUT_EXCEEDS_TOKEN_BUDGET"]})
        # A native chunk remains an immutable, separately addressable source
        # unit. Adjacent chunks may share one CQ task without re-splitting text
        # or discarding their individual headings and table headers.
        windows, members = [], []

        def emit_window():
            if not members:
                return
            material = "\n\n".join(c["contextualized_text"] for c in members)
            count = len(encoding.encode(material))
            if count > budget:
                fail("HYBRID_CHUNK_WINDOW_INTERNAL_OVERFLOW")
            refs = {}
            for child in members:
                for item in child["source_items"]:
                    if item["self_ref"] not in refs or item["role"] == "CORE":
                        refs[item["self_ref"]] = item
            windows.append({"ordinal": len(windows), "member_ordinals": [c["ordinal"] for c in members],
                            "text": material, "contextualized_text": material,
                            "token_count": count,
                            "headings": list(dict.fromkeys(h for c in members for h in c["headings"])),
                            "source_items": list(refs.values()), "status": "PLANNED",
                            "warnings": list(dict.fromkeys(w for c in members for w in c["warnings"]))})

        for chunk in chunks:
            if chunk["status"] != "PLANNED":
                emit_window()
                members = []
                continue
            candidate = "\n\n".join(c["contextualized_text"] for c in [*members, chunk])
            if members and len(encoding.encode(candidate)) > budget:
                emit_window()
                members = []
            members.append(chunk)
        emit_window()
        result["documents"].append({"doc_ref": source["doc_ref"], "revision": source["revision"], "chunks": chunks, "windows": windows})
    Path(target).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        convert(sys.argv[1], sys.argv[2])
    except Exception as error:
        value = str(error)
        code = value if value.startswith("HYBRID_CHUNK_") and value.replace("_", "").isalnum() else (
            "HYBRID_CHUNK_DEPENDENCY_MISSING" if isinstance(error, ImportError) else "HYBRID_CHUNK_FAILED")
        print(json.dumps({"error_type": type(error).__name__, "error_code": code}), file=sys.stderr)
        sys.exit(1)
