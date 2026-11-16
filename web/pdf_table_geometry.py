"""Independent native-text ruled-table recovery. Never infers a cell's meaning."""
from collections import Counter
import logging
import re
import unicodedata
import pdfplumber


def normalized(text):
    return unicodedata.normalize('NFKC', text or '')


def characters(text):
    return Counter(c for c in normalized(text) if not c.isspace())


def recover_ruled_table(page, provenance):
    box = provenance['bbox']
    left, right = box['l'], box['r']
    top, bottom = (page.height-box['t'], page.height-box['b']) if box.get('coord_origin') == 'BOTTOMLEFT' else (box['t'], box['b'])
    # Restrict discovery to the original table region so page frames do not absorb body paragraphs.
    bbox = (max(0,left-1), max(0,top-1), min(page.width,right+1), min(page.height,bottom+1))
    cropped = page.crop(bbox)
    tables = cropped.find_tables({'vertical_strategy':'lines','horizontal_strategy':'lines'})
    valid=[]
    for table in tables:
        values=table.extract(x_tolerance=2,y_tolerance=2)
        pairs=[(row,cells) for row,cells in zip(table.rows,values) if any(v and v.strip() for v in cells)]
        if len(pairs)<2: continue
        width=len(pairs[0][1])
        if width<2 or any(len(values)!=width or len(row.cells)!=width or any(c is None for c in row.cells) for row,values in pairs): continue
        cells=[c for row,_ in pairs for c in row.cells]
        bounds=(min(c[0] for c in cells),min(c[1] for c in cells),max(c[2] for c in cells),max(c[3] for c in cells))
        area=(bounds[2]-bounds[0])*(bounds[3]-bounds[1]); original=(right-left)*(bottom-top)
        overlap=max(0,min(bounds[2],right)-max(bounds[0],left))*max(0,min(bounds[3],bottom)-max(bounds[1],top))
        if overlap/max(area+original-overlap,1)<0.85: continue
        native=[c for c in page.chars if bounds[0]<=(c['x0']+c['x1'])/2<=bounds[2] and bounds[1]<=(c['top']+c['bottom'])/2<=bounds[3]]
        extracted=''.join(v or '' for _,row in pairs for v in row)
        if not extracted.strip() or characters(''.join(c['text'] for c in native))!=characters(extracted): continue
        grid=[]; audit=[]
        for i,(row,values) in enumerate(pairs):
            rendered=[]
            for j,(bounds,raw) in enumerate(zip(row.cells,values)):
                # Line wraps are represented inside the same cell, never across columns.
                text=normalized(raw).replace('\r\n','\n').replace('\n',' ')
                text=re.sub(r'(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])','',text)
                rendered.append(text.replace('|','\\|'))
                audit.append({'row':i,'column':j,'bbox':list(bounds),'raw_text':raw or '', 'text':text})
            grid.append(rendered)
        markdown='\n'.join(['| '+' | '.join(grid[0])+' |','| '+' | '.join(['---']*width)+' |']+['| '+' | '.join(row)+' |' for row in grid[1:]])
        valid.append({'text':markdown,'geometry':{'method':'NATIVE_RULED_GRID_V1','page_no':provenance['page_no'],'coordinate_origin':'TOPLEFT',
            'character_coverage':'EXACT_NATIVE_NONWHITESPACE_MULTISET','unicode_normalization':'NFKC_WITH_RAW_CELL_TEXT_RETAINED','cells':audit}})
    return valid[0] if len(valid)==1 else None


def verify_pdf_tables(source,blocks):
    logging.getLogger('pdfminer').setLevel(logging.ERROR)
    outcomes=[]
    with pdfplumber.open(source) as document:
        for block in blocks:
            if block.get('kind')!='table': continue
            prov=block.get('provenance',[])
            if len(prov)!=1: continue
            p=prov[0]
            if not isinstance(p.get('page_no'),int) or not (1<=p['page_no']<=len(document.pages)): continue
            try: recovered=recover_ruled_table(document.pages[p['page_no']-1],p)
            except (ValueError,KeyError,TypeError): recovered=None
            if recovered:
                block['docling_original_text']=block['text']
                block['text']=recovered['text'];block['table_geometry']=recovered['geometry']
                block['text_origin']='native_pdf_rule_grid_geometry_checked'
                outcomes.append({'block_id':block['block_id'],'page_no':p['page_no'],'status':'GEOMETRY_CHECKED'})
            else: outcomes.append({'block_id':block['block_id'],'page_no':p['page_no'],'status':'DOCLING_ONLY_NOT_GEOMETRY_VERIFIED'})
    return outcomes
