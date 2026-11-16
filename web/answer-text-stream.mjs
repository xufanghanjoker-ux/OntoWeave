/** Extract only blocks[*].statements[*].text while JSON is arriving.
 * This is a display-only draft decoder. Complete JSON and evidence still require validation. */
export function createAnswerTextDecoder(onText){
 const stack=[];let string=null,escaped=false,unicode='',readingUnicode=false,key='',textField=false,seen=false,bad=false,high='';
 const path=()=>{const p=stack.at(-1);return p?[...p.path,p.type==='array'?p.index:p.key]:[];};
 const consumed=()=>{const p=stack.at(-1);if(p){if(p.type==='array')p.index++;else p.expect='comma';}};
 let output='';
 const append=c=>{if(high){if(c.charCodeAt(0)>=0xdc00&&c.charCodeAt(0)<=0xdfff){output+=high+c;high='';return;}output+=high;high='';}if(c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdbff)high=c;else output+=c;};
 const decoded=c=>{if(string==='key')key+=c;else if(textField)append(c);};
 return {push(chunk){
  if(bad)return;
  for(const c of chunk){
   if(string){
    if(readingUnicode){if(!/[0-9a-f]/i.test(c)){bad=true;break;}unicode+=c;if(unicode.length===4){decoded(String.fromCharCode(parseInt(unicode,16)));unicode='';readingUnicode=false;}continue;}
    if(escaped){escaped=false;if(c==='u'){readingUnicode=true;continue;}const escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,c)){bad=true;break;}decoded(escapes[c]);continue;}
    if(c==='\\'){escaped=true;continue;}
    if(c==='"'){if(string==='key'){const p=stack.at(-1);if(p){p.key=key;p.expect='colon';}}string=null;textField=false;continue;}
    decoded(c);continue;
   }
   const parent=stack.at(-1);
   if(c==='"'){
    string=parent?.type==='object'&&parent.expect==='key'?'key':'value';key='';
    if(string==='value'){const p=path();textField=p.length===5&&p[0]==='blocks'&&Number.isInteger(p[1])&&p[2]==='statements'&&Number.isInteger(p[3])&&p[4]==='text';if(textField){if(seen)append('\n\n');seen=true;}consumed();}
   }else if(c==='{'||c==='['){const p=path();consumed();stack.push({type:c==='{'?'object':'array',path:p,key:null,index:0,expect:'key'});}
   else if(c==='}'||c===']')stack.pop();
   else if(c===','&&parent?.type==='object')parent.expect='key';
   else if(c===':'&&parent?.type==='object')parent.expect='value';
  }
  if(output){const text=output;output='';onText(text);}
 }};
}
