/** A quiet world-space grid; panning and zooming never change graph coordinates. */
export function createGraphWorldGrid(surface,renderer){
 if(typeof document==='undefined'||!surface.prepend||!renderer.graphToViewport)return {draw(){},dispose(){}};
 const canvas=document.createElement('canvas');canvas.className='graph-world-grid';canvas.setAttribute('aria-hidden','true');surface.prepend(canvas);
 const context=canvas.getContext('2d');if(!context){canvas.remove();return {draw(){},dispose(){}};}
 let disposed=false;
 function draw(){
  if(disposed)return;const width=surface.clientWidth,height=surface.clientHeight;if(!width||!height)return;
  const dpr=Math.min(globalThis.devicePixelRatio||1,2);if(canvas.width!==width*dpr||canvas.height!==height*dpr){canvas.width=width*dpr;canvas.height=height*dpr;}
  context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,width,height);
  const a=renderer.graphToViewport({x:0,y:0}),unit=renderer.graphToViewport({x:24,y:0}),initial=Math.hypot(unit.x-a.x,unit.y-a.y);if(!Number.isFinite(initial)||initial<=0)return;
  let step=24,spacing=initial;while(spacing<30){step*=4;spacing*=4;}while(spacing>150){step/=4;spacing/=4;}
  const corners=[renderer.viewportToGraph({x:0,y:0}),renderer.viewportToGraph({x:width,y:0}),renderer.viewportToGraph({x:0,y:height}),renderer.viewportToGraph({x:width,y:height})];
  const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),left=Math.floor(Math.min(...xs)/step)*step,right=Math.ceil(Math.max(...xs)/step)*step,bottom=Math.floor(Math.min(...ys)/step)*step,top=Math.ceil(Math.max(...ys)/step)*step;
  context.strokeStyle='#a7d9b60b';context.lineWidth=1;context.beginPath();
  for(let x=left,n=0;x<=right&&n<160;x+=step,n++){const p=renderer.graphToViewport({x,y:bottom}),q=renderer.graphToViewport({x,y:top});context.moveTo(p.x,p.y);context.lineTo(q.x,q.y);}
  for(let y=bottom,n=0;y<=top&&n<160;y+=step,n++){const p=renderer.graphToViewport({x:left,y}),q=renderer.graphToViewport({x:right,y});context.moveTo(p.x,p.y);context.lineTo(q.x,q.y);}
  context.stroke();
 }
 renderer.on('afterRender',draw);draw();return {draw,dispose(){disposed=true;renderer.removeListener('afterRender',draw);canvas.remove();}};
}
