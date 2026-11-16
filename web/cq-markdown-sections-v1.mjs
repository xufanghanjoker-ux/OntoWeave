/** Verbatim heading/body boundaries. No Markdown rendering, arithmetic or edits. */
export function cqMarkdownBlocks(content) {
  const blocks=[];let offset=0,start=0,fence=null;
  const add=(from,to,kind)=>{if(to>from)blocks.push({block_id:'md_'+blocks.length,kind,start:from,end:to,provenance:[]});};
  for(const line of content.match(/[^\n]*\n|[^\n]+$/g)??[]){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(marker){const m=marker[1];if(!fence)fence=m;else if(m[0]===fence[0]&&m.length>=fence.length)fence=null;}
    if(!fence&&/^#{1,6}\s/.test(line)){
      add(start,offset,'markdown');add(offset,offset+line.length,'heading');start=offset+line.length;
    }
    offset+=line.length;
  }
  add(start,content.length,'markdown');return blocks;
}
