"""Native-vector PDF fixtures, no business documents or generation-model calls."""
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import pdfplumber
from pdf_table_geometry import recover_ruled_table
logging.getLogger('pdfminer').setLevel(logging.ERROR)


def fixture(path, ruled=True):
    commands=['50 50 500 700 re S'] if ruled else []
    if ruled:
        commands += [f'{x} 550 m {x} 700 l S' for x in [50,200,375,550]]
        commands += [f'50 {y} m 550 {y} l S' for y in [550,600,650,700]]
    for y,row in zip([670,620,570],[['Property','Alpha','Beta'],['Capacity','10','20'],['Mode','Read','Write']]):
        commands += [f'BT /F1 12 Tf {x} {y} Td ({text}) Tj ET' for x,text in zip([60,210,385],row)]
    commands += ['BT /F1 12 Tf 60 520 Td (Body paragraph outside table) Tj ET']
    content='\n'.join(commands).encode('ascii')
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'\nendstream']
    data=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1): offsets.append(len(data));data+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
    start=len(data);data+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(('%010d 00000 n \n'%o).encode() for o in offsets[1:])+b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n';path.write_bytes(data)


class TableGeometryTests(unittest.TestCase):
    def test_cells_follow_physical_columns_and_exclude_body_inside_page_frame(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/'grid.pdf';fixture(path)
            with pdfplumber.open(path) as pdf:
                result=recover_ruled_table(pdf.pages[0],{'page_no':1,'bbox':{'l':50,'t':700,'r':550,'b':550,'coord_origin':'BOTTOMLEFT'}})
            self.assertIsNotNone(result)
            self.assertIn('| Capacity | 10 | 20 |',result['text'])
            self.assertIn('| Mode | Read | Write |',result['text'])
            self.assertNotIn('Body paragraph',result['text'])
            self.assertEqual(result['geometry']['character_coverage'],'EXACT_NATIVE_NONWHITESPACE_MULTISET')
            cell=next(c for c in result['geometry']['cells'] if c['row']==1 and c['column']==2)
            self.assertEqual(cell['raw_text'],'20');self.assertGreaterEqual(cell['bbox'][0],375)

    def test_unruled_text_is_not_invented_as_a_verified_grid(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/'text.pdf';fixture(path,ruled=False)
            with pdfplumber.open(path) as pdf:
                result=recover_ruled_table(pdf.pages[0],{'page_no':1,'bbox':{'l':50,'t':700,'r':550,'b':550,'coord_origin':'BOTTOMLEFT'}})
            self.assertIsNone(result)


if __name__=='__main__':unittest.main()
