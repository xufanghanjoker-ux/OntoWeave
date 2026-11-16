/** Display-only elastic motion, O(nodes + edges) per step. Never changes knowledge. */
export function createGraphMotion(graph){
  let bodies=new Map(),springs=[],pinned=null,origin=null,scale=1;
  function reset(){
    bodies=new Map();springs=[];pinned=null;origin=null;
    graph.forEachNode((id,a)=>bodies.set(id,{x:a.x,y:a.y,homeX:a.x,homeY:a.y,vx:0,vy:0,degree:graph.degree(id),phase:bodies.size*2.39996323}));
    graph.forEachEdge((id,a,source,target)=>{const s=bodies.get(source),t=bodies.get(target);if(s&&t&&s!==t)springs.push({s,t,dx:t.x-s.x,dy:t.y-s.y});});
    const all=[...bodies.values()];
    scale=all.length?Math.max(80,...all.map(b=>Math.abs(b.x-all[0].x)),...all.map(b=>Math.abs(b.y-all[0].y))):80;
  }
  reset();
  return {
    reset,
    pin(id,x,y){const b=bodies.get(id);if(!b)return;if(pinned!==id)origin={x:b.homeX,y:b.homeY};pinned=id;b.x=x;b.y=y;b.vx=b.vy=0;b.homeX=x;b.homeY=y;},
    release(){
      if(pinned===null)return;
      // Let the connected island relax around the new location, retaining its shape.
      const anchor=bodies.get(pinned),dx=anchor.x-origin.x,dy=anchor.y-origin.y,seen=new Set([pinned]),pending=[pinned];
      while(pending.length){const id=pending.pop();graph.forEachNeighbor(id,other=>{if(!seen.has(other)){seen.add(other);pending.push(other);const b=bodies.get(other);b.homeX+=dx;b.homeY+=dy;}});}
      pinned=null;origin=null;
    },
    step(time,elapsed=16.667,{ambient=true}={}){
      const dt=Math.min(1.5,Math.max(.1,elapsed/16.667)),amplitude=Math.min(3.5,scale*.006);
      for(const b of bodies.values()){
        const dx=ambient?Math.sin(time*.00035+b.phase)*amplitude:0,dy=ambient?Math.cos(time*.00029+b.phase)*amplitude:0;
        b.fx=(b.homeX+dx-b.x)*.004;b.fy=(b.homeY+dy-b.y)*.004;
      }
      for(const {s,t,dx,dy} of springs){
        const strength=.045/Math.sqrt(Math.max(s.degree,t.degree,1));
        const fx=(t.x-s.x-dx)*strength,fy=(t.y-s.y-dy)*strength;
        s.fx+=fx;s.fy+=fy;t.fx-=fx;t.fy-=fy;
      }
      for(const [id,b] of bodies){
        if(id===pinned)continue;
        b.vx=(b.vx+b.fx*dt)*Math.pow(.82,dt);b.vy=(b.vy+b.fy*dt)*Math.pow(.82,dt);
        const speed=Math.hypot(b.vx,b.vy),limit=scale*.018;
        if(speed>limit){b.vx*=limit/speed;b.vy*=limit/speed;}
        b.x+=b.vx*dt;b.y+=b.vy*dt;
      }
      graph.updateEachNodeAttributes((id,a)=>{const b=bodies.get(id);return {...a,x:b.x,y:b.y};},{attributes:['x','y']});
    }
  };
}
