/** Display-only graph styling. Domain identity, direction and knowledge stay upstream. */
export const NATIVE_CANVAS_FONT='Geist, "PingFang SC", "Noto Sans SC", sans-serif';
export const NATIVE_CANVAS_PALETTE=Object.freeze({
  shell:'#10231a',core:'#718b7b',border:'#8ca795',text:'#d9ecdf',
  label:'#14261bf5',hoverLabel:'#294331f5',selectedLabel:'#d9efdf',
  labelBorder:'#52766088',mutedShell:'#182c20',mutedCore:'#405d49',
  edge:'#5e856b',edgeDim:'#294532',edgeFocus:'#b5dfc1',edgeNear:'#8bb89a',
});
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function rgb(value){
 const input=String(value??'').trim(),hex=input.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
 if(hex){let h=hex[1];if(h.length===3)h=[...h].map(c=>c+c).join('');return [0,2,4].map(at=>parseInt(h.slice(at,at+2),16));}
 const color=input.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);return color?color.slice(1,4).map(Number):[156,231,200];
}
export function mixNativeColor(from,to,amount){const a=rgb(from),b=rgb(to),t=clamp(amount,0,1);return 'rgb('+a.map((value,i)=>Math.round(value+(b[i]-value)*t)).join(',')+')';}
export function nativeBaseNodeSize(degree=0){return 5+Math.min(8,Math.sqrt(finite(degree)&&degree>0?degree:0)*1.6);}
export function createNativeLabelLayout(){return {nodeBoxes:[],edgeBoxes:[]};}
export function resetNativeLabelLayout(layout){if(layout){layout.nodeBoxes.length=0;layout.edgeBoxes.length=0;}}

/** Offsets are relative to each edge's true source→target direction, never semantic merges. */
export function layoutNativeParallelEdges(edges=[]){
 const rows=edges.map(edge=>({...edge})),groups=new Map();
 for(const edge of rows){const key=JSON.stringify([String(edge.source),String(edge.target)].sort()),group=groups.get(key)??[];group.push(edge);groups.set(key,group);}
 for(const group of groups.values()){
  group.sort((a,b)=>String(a.canonical_id??a.id).localeCompare(String(b.canonical_id??b.id)));
  const count=group.length,step=Math.min(.18,count>1?1.2/(count-1):.18),ids=group.map(edge=>edge.id);
  group.forEach((edge,index)=>{const offset=index-(count-1)/2,orientation=String(edge.source)<=String(edge.target)?1:-1;edge.curvature=offset===0?0:offset*step*orientation;edge.parallel_ids=[...ids];edge.parallel_count=count;edge.parallel_index=index;edge.native_base_type=nativeEdgeType(edge,false);});
 }
 return rows;
}

export function nativeNodeType(){return 'native-shell';}
export function nativeEdgeType(attributes,focused=false){
 const directed=attributes.direction?!['UNDIRECTED','NONE'].includes(attributes.direction):!['line','native-line','native-curve'].includes(attributes.type);
 const curved=finite(attributes.curvature)&&Math.abs(attributes.curvature)>1e-8;
 return 'native-'+(curved?'curve':'line')+(directed?'-arrow':'')+(focused?'Top':'');
}

/** A single visual state table. Type colour is distinct from hover/selection emphasis. */
export function nativeNodeVisual(attributes,{selected=false,hovered=false,neighbor=false,hasFocus=false,hoverOnly=false,ratio=1,nodeCount=0}={}){
 const a=attributes,typeColor=a.type_color??a.original_color??a.color??'#9ce7c8',base=finite(a.base_size)?a.base_size:nativeBaseNodeSize(a.degree),quiet=hasFocus&&!selected&&!hovered&&!neighbor;
 const out={...a,type:nativeNodeType(a),type_color:typeColor,base_size:base,
  color:mixNativeColor(NATIVE_CANVAS_PALETTE.core,typeColor,.58),shellColor:mixNativeColor(NATIVE_CANVAS_PALETTE.shell,typeColor,.14),borderColor:mixNativeColor(NATIVE_CANVAS_PALETTE.border,typeColor,.32),ringColor:'rgba(0,0,0,0)',
  size:Math.max(5.2,base*.85),zIndex:0,nativeMuted:quiet,nativeActive:selected||hovered,labelInvert:selected,labelBold:selected,labelLift:selected||hovered,hideBaseLabel:hovered,
 };
 const name=String(a.full_label??a.label??''),limit=ratio<.6?24:16,letters=Array.from(name);
 out.label=letters.length>limit?letters.slice(0,limit).join('')+'…':name;out.forceLabel=false;
 if(quiet){out.size=base*(hoverOnly ? .626 : .52);out.shellColor=NATIVE_CANVAS_PALETTE.mutedShell;out.color=mixNativeColor(out.color,NATIVE_CANVAS_PALETTE.mutedCore,hoverOnly ? .78 : 1);out.borderColor='rgba(0,0,0,0)';out.label='';}
 else if(selected){out.size=Math.max(base*1.02,10);out.ringColor=mixNativeColor(typeColor,'#e1f4e6',.35);out.zIndex=4;out.label=name;out.forceLabel=true;}
 else if(hovered){out.size=Math.max(base*1.08,11);out.ringColor=mixNativeColor(typeColor,'#e1f4e6',.7);out.zIndex=5;out.label=name;out.forceLabel=true;}
 else if(neighbor){out.size=Math.max(base*.90,5.6);out.zIndex=2;}
 if(!hasFocus&&ratio>1.8)out.label='';
 // Far overview keeps landmarks; small/near views use Sigma's collision grid for other names.
 if(!hasFocus&&ratio>=.75&&nodeCount>40&&Number(a.degree??0)<2)out.label='';
 return out;
}

export function nativeEdgeVisual(attributes,{picked=false,near=false,hasFocus=false,hoverOnly=false,ratio=1,edgeCount=0}={}){
 const a=attributes,lit=picked||near,base=finite(a.base_size)?a.base_size:1.05,out={...a,type:nativeEdgeType(a,lit),base_size:base};
 out.color=picked?(a.planned?'#e1bf87':NATIVE_CANVAS_PALETTE.edgeFocus):near?(a.planned?'#bda477':NATIVE_CANVAS_PALETTE.edgeNear):hasFocus?NATIVE_CANVAS_PALETTE.edgeDim:a.planned?'#8e7c55':NATIVE_CANVAS_PALETTE.edge;
 out.size=picked?Math.max(base*2.3,2.6):near?Math.max(base*1.42,1.6):hasFocus?base*(hoverOnly ? .78 : .6):base;
 out.zIndex=lit?5:0;
 const show=lit||!hasFocus&&(edgeCount<=40||ratio<.7);out.label=show?String(a.label??a.predicate_label??''):'';
 out.forceLabel=picked||!hasFocus&&ratio<.35;out.nativePicked=picked;out.nativeFocused=lit;
 return out;
}

function canvasSize(context){
 const canvas=context.canvas??{},dpr=typeof devicePixelRatio==='number'?devicePixelRatio:1;
 return {width:canvas.clientWidth||canvas.width/dpr||Infinity,height:canvas.clientHeight||canvas.height/dpr||Infinity};
}
function fitText(context,text,width){
 if(context.measureText(text).width<=width)return text;
 const chars=Array.from(text);let low=0,high=chars.length;while(low<high){const middle=Math.ceil((low+high)/2);if(context.measureText(chars.slice(0,middle).join('')+'…').width<=width)low=middle;else high=middle-1;}return chars.slice(0,low).join('')+'…';
}
function roundRect(context,x,y,width,height,radius){context.beginPath();if(context.roundRect)context.roundRect(x,y,width,height,radius);else context.rect(x,y,width,height);}
function boxKey(data){return data.key??data.id??data.canonical_id??null;}
function forgetBox(boxes,key){if(!boxes||key===null)return;const index=boxes.findIndex(box=>box.key===key);if(index>=0)boxes.splice(index,1);}
function rememberBox(boxes,box,key){if(!boxes)return;forgetBox(boxes,key);boxes.push({...box,key});}
function overlapsBox(a,b,padding=3){return a.width>0&&a.height>0&&b.width>0&&b.height>0&&a.x<b.x+b.width+padding&&a.x+a.width+padding>b.x&&a.y<b.y+b.height+padding&&a.y+a.height+padding>b.y;}

/** Geometry is exported so edge-of-viewport behaviour can be checked without a browser. */
export function nativeNodeLabelGeometry(context,data,settings={}){
 const {width:vw,height:vh}=canvasSize(context),fontSize=11,padX=7,padY=3,margin=5;
 context.font=`${data.labelBold?600:500} ${fontSize}px ${settings.labelFont??NATIVE_CANVAS_FONT}`;
 const text=fitText(context,String(data.label??''),Math.max(1,vw-margin*2-padX*2)),width=context.measureText(text).width,height=fontSize+padY*2,size=data.size??6;
 const dx=Math.max(size*.7,12),dy=Math.max(size*.9,10)+fontSize/2+padY;
 let x=data.x+dx;if(x+width+padX>vw-margin)x=data.x-dx-width;
 let y=data.y-dy;if(y-height/2<margin)y=data.y+dy;
 x=clamp(x,margin+padX,Math.max(margin+padX,vw-margin-padX-width));y=clamp(y,margin+height/2,Math.max(margin+height/2,vh-margin-height/2));
 return {text,x,y,width,height,padX,fontSize,box:{x:x-padX,y:y-height/2,width:width+padX*2,height}};
}
export function drawNativeNodeLabel(context,data,settings={}){
 if(!data.label)return;
 const layout=settings.nativeLabelLayout,key=boxKey(data);forgetBox(layout?.nodeBoxes,key);
 context.save();const g=nativeNodeLabelGeometry(context,data,settings),forced=data.forceLabel||data.nativeActive||data.labelInvert||data.labelLift;
 if(layout&&!data.hideBaseLabel&&!forced&&layout.nodeBoxes.some(occupied=>overlapsBox(g.box,occupied))){context.restore();return;}
 rememberBox(layout?.nodeBoxes,g.box,key);
 // The hover pass owns painting, but its space must already be reserved for edge labels.
 if(data.hideBaseLabel){context.restore();return;}
 context.textBaseline='middle';context.textAlign='left';
 if(data.labelLift){context.shadowColor='#08150d99';context.shadowBlur=10;}
 roundRect(context,g.box.x,g.box.y,g.box.width,g.box.height,4);context.fillStyle=data.labelInvert?NATIVE_CANVAS_PALETTE.selectedLabel:data.labelLift?NATIVE_CANVAS_PALETTE.hoverLabel:NATIVE_CANVAS_PALETTE.label;context.fill();context.shadowBlur=0;
 if(!data.labelInvert){context.lineWidth=1;context.strokeStyle=NATIVE_CANVAS_PALETTE.labelBorder;context.stroke();}
 context.fillStyle=data.labelInvert?'#183522':data.nativeMuted?'#91aa99':NATIVE_CANVAS_PALETTE.text;context.fillText(g.text,g.x,g.y);context.restore();
}
export function drawNativeNodeHover(context,data,settings={}){drawNativeNodeLabel(context,{...data,hideBaseLabel:false,labelLift:true},settings);}

/** Source/target are Sigma viewport positions. Curve labels follow the actual quadratic midpoint. */
export function nativeEdgeLabelGeometry(edge,source,target){
 const dx=target.x-source.x,dy=target.y-source.y,curvature=finite(edge.curvature)?edge.curvature:0;
 let angle=Math.atan2(dy,dx);if(angle>Math.PI/2)angle-=Math.PI;if(angle< -Math.PI/2)angle+=Math.PI;
 // Sigma's WebGL viewport has the opposite Y axis to this 2D label canvas.
 return {x:(source.x+target.x)/2+dy*curvature/2,y:(source.y+target.y)/2-dx*curvature/2,angle,length:Math.hypot(dx,dy)};
}
export function nativeRotatedLabelBox(x,y,width,height,angle){
 const c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle)),boxWidth=c*width+s*height,boxHeight=s*width+c*height;
 return {x:x-boxWidth/2,y:y-boxHeight/2,width:boxWidth,height:boxHeight};
}
export function drawNativeEdgeLabel(context,edge,source,target,settings={}){
 const layout=settings.nativeLabelLayout,key=boxKey(edge);forgetBox(layout?.edgeBoxes,key);
 if(!edge.label||edge.hidden||source.hidden||target.hidden)return;
 const dx=target.x-source.x,dy=target.y-source.y,length=Math.hypot(dx,dy);if(length<1)return;
 const fontSize=11,padding=4;
 context.save();context.font=`${edge.nativePicked?600:500} ${fontSize}px ${settings.labelFont??NATIVE_CANVAS_FONT}`;
 const available=Math.max(20,length-(source.size??0)-(target.size??0)-16);if(available<35&&!edge.forceLabel){context.restore();return;}
 const text=fitText(context,String(edge.label),Math.min(available,edge.forceLabel?300:180)),width=context.measureText(text).width;
 const {x,y,angle}=nativeEdgeLabelGeometry(edge,source,target);
 const box=nativeRotatedLabelBox(x,y,width+padding*2,fontSize+6,angle);
 if(layout&&!edge.forceLabel&&!edge.nativePicked&&[...layout.nodeBoxes,...layout.edgeBoxes].some(occupied=>overlapsBox(box,occupied))){context.restore();return;}
 rememberBox(layout?.edgeBoxes,box,key);
 context.translate(x,y);context.rotate(angle);context.textAlign='center';context.textBaseline='middle';
 roundRect(context,-width/2-padding,-fontSize/2-3,width+padding*2,fontSize+6,3);context.fillStyle=edge.nativePicked?'#d9efdf':edge.nativeFocused?'#233c2bf5':'#14261bf2';context.fill();
 context.fillStyle=edge.nativePicked?'#183522':edge.nativeFocused?'#dcf0e2':'#a3c2ad';context.fillText(text,0,0);context.restore();
}
