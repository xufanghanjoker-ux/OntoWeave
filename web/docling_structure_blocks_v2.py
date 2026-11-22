"""Versioned, frozen selectable units; called only by the local Docling worker."""
import hashlib
import re


def build_structure_blocks(doc, raw, encoding, budget, chunker, source_item, document_title=""):
    from docling_core.types.doc import SectionHeaderItem, TitleItem, TableItem
    from types import SimpleNamespace
    count = lambda s: len(encoding.encode(s))
    digest = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()
    items = {i.self_ref: i for i, _ in doc.iterate_items(with_groups=True)}
    paths, heads = {}, {}
    for i, _ in doc.iterate_items(with_groups=True):
        if isinstance(i, (TitleItem, SectionHeaderItem)):
            level = i.level if isinstance(i, SectionHeaderItem) else 0
            heads = {k: v for k, v in heads.items() if k < level}
            heads[level] = i.text
        paths[i.self_ref] = list(heads.values())
    originals = []
    for b in raw['blocks']:
        if not b.get('text', '').strip():
            continue
        i = items.get(b['block_id'])
        context = paths.get(b['block_id'], [])
        if isinstance(i, (TitleItem, SectionHeaderItem)):
            context = []
        # Caption, unit and footnote text is repeated on every continuation.
        if isinstance(i, TableItem):
            context = context + [getattr(r.resolve(doc), 'text', '') for r in [*i.captions, *i.footnotes]]
        originals.append({'text': b['text'], 'context': '\n'.join(filter(None, [('文档：' + document_title) if document_title else '', *context])),
                          'headings': paths.get(b['block_id'], []), 'block_id': b['block_id'],
                          'source_items': [source_item(i, 'CORE')] if i else [], 'fragment': 'whole',
                          'text_sha256': digest(b['text'])})

    def render(units, contextual=True):
        return ((('文档：' + document_title + '\n\n') if document_title and not contextual else '') + '\n\n'.join((('[CONTEXT]\n' + u['context'] + '\n') if contextual and u['context'] else '')
                           + f"[U{n+1:03d}] " + u['text'] for n, u in enumerate(units)))

    # Small document: each original structural unit remains selectable, with the
    # headings already present in the ordered document rather than duplicated.
    if count(render(originals, False)) <= budget:
        groups = [(originals, False)] if originals else []
        gaps = []
    else:
        groups, gaps, pending = [], [], []
        def emit():
            nonlocal pending
            if pending:
                groups.append((pending, True))
                pending = []
        def accept(u):
            nonlocal pending
            if count(render([u])) > budget:
                gaps.append({**u, 'reason': 'STRUCTURE_CONTEXT_OR_UNIT_EXCEEDS_BUDGET'})
                return
            # Only combine peers from the same structural context. There is no
            # later CQ-window packing pass.
            if pending and (pending[-1]['context'] != u['context'] or count(render([*pending, u])) > budget):
                emit()
            pending.append(u)
        for original in originals:
            if count(render([original])) <= budget:
                accept(original)
                continue
            emit()
            i = items.get(original['block_id'])
            if isinstance(i, TableItem):
                cells = i.data.table_cells
                header = [c for c in cells if c.column_header]
                header_text = '; '.join(f'column {c.start_col_offset_idx+1}: {c.text}' for c in header)
                context = original['context'] + ('\n[TABLE HEADERS]\n' + header_text if header_text else '')
                # Cell coordinates retain row identity even for horizontal splits,
                # merged cells, or cells with no unique first-column identifier.
                parts = [(f"row {c.start_row_offset_idx+1}-{c.end_row_offset_idx}, column {c.start_col_offset_idx+1}-{c.end_col_offset_idx}: {c.text}",
                          f'cell-{n}') for n, c in enumerate(cells) if not c.column_header]
                if not parts: parts = [(original['text'], 'header-only')]
            else:
                context = original['context']
                parts = [(original['text'], 'text')]
            for text, identity in parts:
                base = {**original, 'context': context, 'fragment': identity}
                overhead = count(render([{**base, 'text': ''}])) + 32
                available = budget - overhead
                if available <= 0:
                    gaps.append({**base, 'text': text, 'reason': 'STRUCTURE_CONTEXT_EXHAUSTS_BUDGET'})
                    continue
                # Same semantic token splitting used by HybridChunker for plain
                # text, with extra budget reserved for actual reference markers.
                pieces = chunker.segment(SimpleNamespace(text=text, meta=SimpleNamespace(doc_items=[i] if i else [])), available, None)
                if re.sub(r'\s+', '', ''.join(pieces)) != re.sub(r'\s+', '', text):
                    gaps.append({**base, 'text': text, 'reason': 'STRUCTURE_SPLIT_COVERAGE_MISMATCH'})
                    continue
                for n, piece in enumerate(pieces):
                    accept({**base, 'text': piece, 'fragment': f'{identity}/part-{n}', 'text_sha256': digest(piece)})
        emit()
    chunks = []
    for ordinal, (group, contextual) in enumerate(groups):
        units = [{**u, 'label': f'U{n+1:03d}', 'ordinal': n, 'context': u['context']} for n, u in enumerate(group)]
        material = render(units, contextual)
        refs = {r['self_ref']: r for u in units for r in u['source_items']}
        chunks.append({'ordinal': ordinal, 'text': material, 'contextualized_text': material,
                       'token_count': count(material), 'headings': list(dict.fromkeys(h for u in units for h in u['headings'])),
                       'source_items': list(refs.values()), 'units': units, 'status': 'PLANNED', 'warnings': [],
                       'core_text_tokens': sum(count(u['text']) for u in units),
                       'context_tokens': sum(count(u['context']) for u in units) if contextual else 0,
                       'material_sha256': digest(material)})
    # Explicit gaps retain all affected source text. They never become processed.
    for gap in gaps:
        chunks.append({'ordinal': len(chunks), 'text': gap['text'], 'contextualized_text': gap['text'],
                       'token_count': count(gap['text']), 'headings': gap['headings'],
                       'source_items': gap['source_items'], 'status': 'GAP', 'warnings': [gap['reason']], 'retained_unit': gap})
    return chunks
