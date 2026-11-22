"""Local conversion only. Original files are never sent to the extraction LLM here."""
import json
import re
import sys
from io import BytesIO
from importlib.metadata import version
from pathlib import Path
from zipfile import ZipFile

from docling.document_converter import DocumentConverter, MarkdownFormatOption, PdfFormatOption
from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.backend_options import MarkdownBackendOptions
from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions


def restrict_markdown_operations(event, args):
    """The Markdown worker only reads its local input; resources and code stay inert."""
    if event.startswith('socket.') or event.startswith('subprocess.') or event in {
        'os.system', 'os.exec', 'os.posix_spawn', 'os.posix_spawnp',
    }:
        raise PermissionError('MARKDOWN_EXTERNAL_OPERATION_FORBIDDEN')


def protect_markdown_math(text):
    """Keep display formulas literal instead of letting Markdown escapes split them.

    The original file is untouched. A math fence in the parser input is a literal
    container only; nothing is rendered or executed. Keep the original formula
    delimiters and every character, and record the source ranges in docling.json.
    """
    lines = text.splitlines(keepends=True)
    result, protected = [], []
    i, offset, open_fence = 0, 0, None
    while i < len(lines):
        line = lines[i]
        fence = re.match(r'^\s{0,3}(`{3,}|~{3,})(.*)$', line.rstrip('\r\n'))
        if fence:
            marker = fence.group(1)
            if open_fence is None:
                open_fence = (marker[0], len(marker))
            elif marker[0] == open_fence[0] and len(marker) >= open_fence[1] and not fence.group(2).strip():
                open_fence = None
        delimiter = line.strip()
        if open_fence is None and not line.startswith(('    ', '\t')) and delimiter in ('[', '$$', '\\['):
            closing = {'[': ']', '$$': '$$', '\\[': '\\]'}[delimiter]
            end = i + 1
            while end < len(lines) and lines[end].strip() != closing:
                end += 1
            if end < len(lines):
                literal = ''.join(lines[i:end + 1])
                if delimiter != '[' or re.search(r'\\[A-Za-z]+', literal):
                    width = max([3] + [len(m.group(0)) + 1 for m in re.finditer(r'`+', literal)])
                    wrapper = '`' * width
                    result.extend([wrapper + 'math\n', literal, '' if literal.endswith('\n') else '\n', wrapper + '\n'])
                    protected.append({'start': offset, 'end': offset + len(literal),
                                      'offset_unit': 'unicode_code_point',
                                      'offset_domain': 'decoded_utf8_sig_source', 'literal': literal})
                    offset += len(literal)
                    i = end + 1
                    continue
        result.append(line)
        offset += len(line)
        i += 1
    return ''.join(result), protected


def markdown_blocks(document):
    # Plain item.text drops inline formatting, including deleted definitions. Use the
    # native serializer and its visited set so rich groups/tables are emitted once.
    from docling_core.transforms.serializer.markdown import MarkdownDocSerializer, MarkdownParams
    from docling_core.types.doc.document import DocItem, InlineGroup, ListGroup
    serializer = MarkdownDocSerializer(doc=document, params=MarkdownParams(escape_underscores=False))
    visited = set()
    for item, _ in document.iterate_items(with_groups=True):
        if not isinstance(item, (DocItem, InlineGroup, ListGroup)) or item.self_ref in visited:
            continue
        serialized = serializer.serialize(item=item, visited=visited)
        if not serialized.text.strip():
            continue
        provenance = []
        for span in serialized.spans:
            for p in getattr(span.item, 'prov', []):
                value = {'page_no': p.page_no, 'bbox': p.bbox.model_dump(mode='json')}
                if value not in provenance:
                    provenance.append(value)
        yield {'block_id': item.self_ref, 'kind': str(item.label.value),
               'text': serialized.text, 'provenance': provenance,
               'text_origin': 'parser_output_not_verified'}


def convert(source, target):
    extension = Path(source).suffix.lower()
    if extension == '.docx':
        with ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(e.file_size for e in entries) > 200 * 1024 * 1024:
                raise ValueError('DOCX解压规模超限')
            if 'word/document.xml' not in archive.namelist():
                raise ValueError('缺少Word文档主体')
    if extension == '.md':
        sys.addaudithook(restrict_markdown_operations)
        markdown_text = Path(source).read_bytes().decode('utf-8-sig')
        parser_text, protected_math = protect_markdown_math(markdown_text)
        converter = DocumentConverter(
            allowed_formats=[InputFormat.MD],
            format_options={InputFormat.MD: MarkdownFormatOption(backend_options=MarkdownBackendOptions(
                enable_remote_fetch=False, enable_local_fetch=False, fetch_images=False))},
        )
    else:
        options = PdfPipelineOptions()
        artifacts = Path(__file__).resolve().parent.parent / '.ontoweave' / 'docling-models' / 'artifacts'
        if (artifacts / '.download-complete').exists():
            options.artifacts_path = artifacts
            options.ocr_options = RapidOcrOptions()
        else:
            pinned = artifacts.parent / 'ocr-pinned'
            names = ['PP-OCRv6_det_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'PP-OCRv6_rec_small.onnx', 'ppocrv6_dict.txt']
            if not all((pinned / name).is_file() for name in names):
                raise FileNotFoundError('Missing pinned OCR models; run npm run setup:parser')
            options.ocr_options = RapidOcrOptions(det_model_path=str(pinned / names[0]), cls_model_path=str(pinned / names[1]),
                                                 rec_model_path=str(pinned / names[2]), rec_keys_path=str(pinned / names[3]))
        options.enable_remote_services = False
        options.do_ocr = True
        options.do_table_structure = True
        converter = DocumentConverter(
            allowed_formats=[InputFormat.PDF, InputFormat.DOCX],
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
        )
    parser_source = DocumentStream(name=Path(source).name, stream=BytesIO(parser_text.encode('utf-8'))) if extension == '.md' else Path(source)
    result = converter.convert(parser_source, raises_on_error=True)
    if str(result.status.value) != "success":
        raise ValueError("解析未完整成功，不将部分内容作为完整资料")
    document = result.document
    blocks = list(markdown_blocks(document)) if extension == '.md' else []
    for item, _ in ([] if extension == '.md' else document.iterate_items()):
        label = str(item.label.value)
        if label == "table":
            # Keep the table structure in the full JSON and map its serialization to the table block.
            content = item.export_to_markdown(doc=document)
        else:
            content = getattr(item, "text", "")
        if not content.strip():
            continue
        provenance = []
        for p in getattr(item, "prov", []):
            provenance.append({"page_no": p.page_no, "bbox": p.bbox.model_dump(mode="json")})
        blocks.append({"block_id": item.self_ref, "kind": label, "text": content,
                       "provenance": provenance, "text_origin": "parser_output_not_verified"})
    table_checks=[]
    if Path(source).suffix.lower()=='.pdf':
        from pdf_table_geometry import verify_pdf_tables
        table_checks=verify_pdf_tables(source,blocks)
    if not blocks:
        raise ValueError("没有解析出可用文字")
    warnings = ["OCR、表格及阅读顺序可能有误；引文匹配解析文字不代表原件核实。",
                "Word 无可靠页码时使用段落或表格块定位，不补造页码。"]
    if extension == '.md':
        warnings = ["Markdown由Docling本机解析；远程和本地资源读取均禁用，代码块只作文本不执行。",
                    "Markdown使用文档块定位，不补造页码；格式可能由Docling规范化，引文匹配不代表事实核实。"]
        if document.pictures:
            warnings.append("MARKDOWN_IMAGES_NOT_LOADED：图片未加载，仅保留占位和已有文字，不推断图片内容。")
        if '~~' in markdown_text:
            warnings.append("MARKDOWN_STRIKETHROUGH：原件含删除线，保留的~~标记表示删除内容，不能作为当前生效定义。")
            flattened = '\n\n'.join(block['text'] for block in blocks)
            unmatched = sum(1 for fragment in re.findall(r'~~(.+?)~~', markdown_text, re.DOTALL)
                            if '~~' + fragment + '~~' not in flattened)
            if unmatched:
                warnings.append("MARKDOWN_STRIKETHROUGH_REVIEW_REQUIRED：部分删除标记未在平铺输出逐字保留，不能据此采用为当前定义，须回查原件。")
        if protected_math:
            warnings.append("MARKDOWN_MATH_LITERAL：显示公式以只读文字容器保留原始字符，不渲染或计算；原始范围记录在Docling JSON。")
    payload = {"parser": "docling", "parser_version": version("docling")+("+markdown-local-v1" if extension == '.md' else "+ruled-grid-v1"), "table_checks":table_checks,
               "blocks": blocks, "document": document.export_to_dict(),
               "warnings": warnings}
    if extension == '.md':
        payload['markdown_math_literals'] = protected_math
    Path(target).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        convert(sys.argv[1], sys.argv[2])
    except Exception as exc:
        # Do not print document contents or environment credentials into server logs.
        name = type(exc).__name__
        message = str(exc).lower()
        code = 'MISSING_MODEL' if any(x in message for x in ['snapshot', 'offline', 'not found', 'no such file']) else 'PARSER_FAILED'
        if isinstance(exc, ImportError) or 'not installed' in message:
            code = 'MISSING_DEPENDENCY'
        if '没有解析出' in message:
            code = 'NO_TEXT'
        print(json.dumps({"error_type": name, "error_code": code}), file=sys.stderr)
        sys.exit(1)
