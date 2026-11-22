"""Synthetic initialization only: no business documents and no generation-model credentials."""
import hashlib
import json
import os
import sys
import shutil
from importlib.util import find_spec
from pathlib import Path
from importlib.metadata import version

root = Path(__file__).resolve().parent.parent
out = root / '.ontoweave' / 'parser-fixtures'
out.mkdir(parents=True, exist_ok=True)


def fixtures():
    from zipfile import ZipFile
    from PIL import Image, ImageDraw, ImageFont
    lines = ['Synthetic provider verification', 'Languages supported: 44', 'Resolution rate: 95%',
             'This synthetic provider does not claim medical support.']
    # Earlier RapidOCR releases cached checkpoints inside site-packages. Copy, do not move.
    legacy_ocr = Path(find_spec('rapidocr').origin).parent / 'models'
    pinned_ocr = root / '.ontoweave' / 'docling-models' / 'ocr-pinned'
    for name in ['PP-OCRv6_det_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'PP-OCRv6_rec_small.onnx', 'ppocrv6_dict.txt']:
        if (legacy_ocr / name).is_file() and not (pinned_ocr / name).exists():
            pinned_ocr.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(legacy_ocr / name, pinned_ocr / name)
    with ZipFile(out / 'synthetic-provider.docx', 'w') as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        paragraphs = ''.join('<w:p><w:r><w:t>' + line + '</w:t></w:r></w:p>' for line in lines)
        table = '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>' + ''.join('<w:tc><w:p><w:r><w:t>' + value + '</w:t></w:r></w:p></w:tc>' for value in ['Languages', '44']) + '</w:tr></w:tbl>'
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + table + '</w:body></w:document>')
    content = '\n'.join('BT /F1 14 Tf 50 ' + str(770 - i * 40) + ' Td (' + line + ') Tj ET' for i, line in enumerate(lines)).encode('ascii')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream']
    data = b'%PDF-1.4\n'; offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    xref = len(data)
    data += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(('%010d 00000 n \n' % offset).encode() for offset in offsets[1:])
    data += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
    (out / 'synthetic-provider.pdf').write_bytes(data)
    image = Image.new('RGB', (1600, 1000), 'white')
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((60, 70 + i * 100), line, font=ImageFont.load_default(size=32), fill='black')
    image.save(out / 'synthetic-scan.pdf', 'PDF', resolution=150)


if __name__ == '__main__':
    if '--download' in sys.argv:
        from docling.utils.model_downloader import download_models
        artifacts = root / '.ontoweave' / 'docling-models' / 'artifacts'
        download_models(output_dir=artifacts, force='--force' in sys.argv, with_layout=True, with_tableformer=True, with_code_formula=False,
                        with_picture_classifier=False, with_smolvlm=False, with_granitedocling=False,
                        with_smoldocling=False, with_granite_vision=False, with_rapidocr=True)
        (artifacts / '.download-complete').write_text('download returned; offline smoke still required')
    fixtures()
