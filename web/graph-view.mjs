export {projectSourceGraph,inspectSourceGraph} from './source-graph-data-v1.mjs';
export {projectNativeDomainGraph,inspectNativeDomainGraph} from './native-domain-graph-data-v1.mjs';
export {nativeDomainGraphMarkup,nativeDomainInspector,nativeDomainEntityList,nativeDomainKnowledgeList} from './native-domain-graph-view-v1.mjs';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import {projectGraph,entityKey,claimKey,neighbors} from './graph-data.mjs';
import {createGraphMotion} from './graph-motion.mjs';
import {createGraphFA2Layout,graphFA2Settings} from './graph-fa2-layout-v1.mjs';
import {nativeNodeVisual,nativeEdgeVisual,layoutNativeParallelEdges,nativeBaseNodeSize,resetNativeLabelLayout} from './graph-native-visuals-v1.mjs';
import {nativeRendererSettings} from './graph-native-programs-v1.mjs';
import {createGraphWorldGrid} from './graph-world-grid-v1.mjs';

const layoutMemory=new Map();

function drawDarkNodeHover(context,data,settings){
  const label=typeof data.label==='string'?data.label:'',fontSize=settings.labelSize??12,size=data.size??6;
  context.save();context.font=`${settings.labelWeight??'400'} ${fontSize}px ${settings.labelFont??'sans-serif'}`;
  const width=label?context.measureText(label).width:0,height=Math.max(fontSize+12,size*2+8),left=data.x-size-5,top=data.y-height/2;
  context.fillStyle='#14231d';context.strokeStyle='#6eaa90';context.lineWidth=1;
  context.fillRect(left,top,size*2+width+(label?20:10),height);context.strokeRect(left,top,size*2+width+(label?20:10),height);
  context.beginPath();context.arc(data.x,data.y,size,0,Math.PI*2);context.fillStyle=data.color??'#9ce7c8';context.fill();
  if(label){context.fillStyle='#e5fff2';context.fillText(label,data.x+size+6,data.y+fontSize*.35);}
  context.restore();
}

/** Domain canvas with bounded upstream ForceAtlas2 and version-bound browsing state. */
export function createGraphView(container,task,{onSelect=()=>{},layoutKey=task.id,projectionFactory=projectGraph,statementLabel='声明',edgeLabels='focus',labelTheme='default',context=null}={}){
  const native=labelTheme==='native-domain',hiddenTypes=new Set();
  const status=container.querySelector('[data-graph-status]'),surface=container.querySelector('[data-graph-surface]');
  const graph=new Graph({multi:true,type:'directed'}),positions=new Map(layoutMemory.get(layoutKey)||[]);
  let motion,physics,grid,frame=null,lastTime=0,paused=native,halo,initialLayoutPrepared=false,dragOrigin=null,lastPhysicsState={running:false,phase:'idle',iterations:0};const layoutHistory=[];
  const previousIds=new Set(positions.keys()),birthTime=Date.now();
  const reduced=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
  const motionAllowed=()=>!native&&!paused&&!reduced?.matches&&layoutMode==='force';
  let renderer,projection,selected=null,hover=null,focus=null,dragged=null,dragging=false,disposed=false,layoutMode='force',suppressClickUntil=0;
  let selectedEdges=new Set(),selectedObjects=new Set(),hoverEdge=null,selectionCanonical=null,temporaryContext=null,projectionFocusId=null,contextSeeded=false;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const validContext=value=>value&&value.version===projection?.version&&Array.isArray(value.positions);
  function rememberPositions(){graph.forEachNode((id,a)=>positions.set(id,{x:a.x,y:a.y}));}
  function importPositions(value){for(const p of value??[])if(typeof p?.id==='string'&&finite(p.x)&&finite(p.y))positions.set(p.id,{x:p.x,y:p.y});}
  const setStatus=text=>{status.textContent=text;};
  const canonical=id=>{const a=graph.getNodeAttributes(id);return{id:a.canonical_id,kind:a.kind};};
  function applyLayout(mode='force'){
    physics?.stop('layout-change');layoutMode=mode;
    if(native&&mode==='force'){let index=0;graph.forEachNode(id=>{const angle=(index++/Math.max(1,graph.order))*Math.PI*2;graph.mergeNodeAttributes(id,{x:Math.cos(angle)*300,y:Math.sin(angle)*300});});if(graph.order>1)forceAtlas2.assign(graph,{iterations:60,settings:graphFA2Settings(graph)});rememberPositions();return;}
    let i=0;
    graph.forEachNode((id,a)=>{
      if(positions.has(id)&&mode==='keep'){graph.mergeNodeAttributes(id,positions.get(id));return;}
      const angle=i*2.3999632297,r=20+Math.sqrt(i+1)*26;i++;
      if(mode==='keep'&&a.kind==='statement'&&positions.has(entityKey(a.subject_id))){const p=positions.get(entityKey(a.subject_id));graph.mergeNodeAttributes(id,{x:p.x+Math.cos(angle)*45,y:p.y+Math.sin(angle)*45});return;}
      if(mode==='keep'){const anchors=graph.neighbors(id).filter(other=>positions.has(other)).map(other=>positions.get(other));if(anchors.length){graph.mergeNodeAttributes(id,{x:anchors.reduce((n,p)=>n+p.x,0)/anchors.length+Math.cos(angle)*14,y:anchors.reduce((n,p)=>n+p.y,0)/anchors.length+Math.sin(angle)*14});return;}}
      graph.mergeNodeAttributes(id,{x:r*Math.cos(angle),y:r*Math.sin(angle)});
    });
    if(mode==='force'&&graph.order>1){forceAtlas2.assign(graph,{iterations:graph.order>400?80:180,settings:{...forceAtlas2.inferSettings(graph),
      gravity:.35,scalingRatio:22,barnesHutOptimize:graph.order>200,slowDown:4,adjustSizes:true,
      outboundAttractionDistribution:true,strongGravityMode:false}});}
    // Disconnected knowledge islands are packed apart; never draw an invented connecting edge.
    if(mode==='force'){
      const unseen=new Set(graph.nodes()),groups=[];
      while(unseen.size){const pending=[unseen.values().next().value],group=[];unseen.delete(pending[0]);
        while(pending.length){const id=pending.pop();group.push(id);graph.forEachNeighbor(id,other=>{if(unseen.delete(other))pending.push(other);});}groups.push(group);}
      if(native){
        // Pack components by their actual footprint. No synthetic connection is
        // introduced between islands, including singleton objects.
        const boxes=groups.sort((a,b)=>b.length-a.length).map(group=>{
          const attrs=group.map(id=>graph.getNodeAttributes(id)),xs=attrs.map(a=>a.x),ys=attrs.map(a=>a.y),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys),span=Math.max(w,h,1),scale=(65+Math.sqrt(group.length)*48)/span;
          return {group,cx:(Math.min(...xs)+Math.max(...xs))/2,cy:(Math.min(...ys)+Math.max(...ys))/2,scale,width:Math.max(88,w*scale+66),height:Math.max(72,h*scale+62)};
        });
        const aspect=Math.max(.8,Math.min(1.8,(surface.clientWidth||600)/(surface.clientHeight||500))),area=boxes.reduce((sum,b)=>sum+(b.width+16)*(b.height+16),0),target=Math.max(0,...boxes.map(b=>b.width),Math.sqrt(area*aspect));
        let x=0,y=0,rowHeight=0;
        for(const box of boxes){if(x&&x+box.width>target){x=0;y+=rowHeight+16;rowHeight=0;}
          for(const id of box.group){const a=graph.getNodeAttributes(id);graph.mergeNodeAttributes(id,{x:x+box.width/2+(a.x-box.cx)*box.scale,y:y+box.height/2+(a.y-box.cy)*box.scale});}
          x+=box.width+16;rowHeight=Math.max(rowHeight,box.height);
        }
      }else if(groups.length>1){const columns=Math.ceil(Math.sqrt(groups.length));groups.forEach((group,index)=>{
        const attrs=group.map(id=>graph.getNodeAttributes(id)),xs=attrs.map(a=>a.x),ys=attrs.map(a=>a.y),
          cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2,
          span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),1),radius=Math.min(165,65+Math.sqrt(group.length)*16),
          x=(index%columns)*400+(groups.length===3&&index===2?200:0),y=Math.floor(index/columns)*370;
        group.forEach(id=>{const a=graph.getNodeAttributes(id);graph.mergeNodeAttributes(id,{x:x+(a.x-cx)/span*radius*2,y:y+(a.y-cy)/span*radius*2});});
      });}
    }
    graph.forEachNode((id,a)=>positions.set(id,{x:a.x,y:a.y}));
    motion?.reset();
  }
  function populate(statements,{focusId=null}={}){
    physics?.stop('projection-change');graph.forEachNode((id,a)=>positions.set(id,{x:a.x,y:a.y}));
    projection=projectionFactory(task,{statements,focusId});projectionFocusId=focusId;graph.clear();
    if(!contextSeeded&&validContext(context))importPositions(context.positions);contextSeeded=true;initialLayoutPrepared=native&&!positions.size&&layoutMode==='force';
    for(const node of projection.nodes){const displayLabel=node.display_badge?`[${node.display_badge}] ${node.label}`:node.label;graph.addNode(node.id,{...node,x:0,y:0,
      size:native?nativeBaseNodeSize(node.degree):node.structure_kind?5.5:node.kind==='entity'?7+Math.min(5,Math.sqrt(node.degree)):2.6,
      full_label:displayLabel,label:[...displayLabel].length>(native?24:18)?[...displayLabel].slice(0,native?24:18).join('')+'…':displayLabel});}
    for(const edge of (native?layoutNativeParallelEdges(projection.edges):projection.edges))graph.addEdgeWithKey(edge.id,edge.source,edge.target,{...edge,label:edge.display_badge?`[${edge.display_badge}] ${edge.label}`:edge.label,color:edge.planned?'#887456':native?'#6c9c7d':edgeLabels==='auto'?'#739d8c':'#344a40',size:native?1.2:edgeLabels==='auto'?1.1:.5});
    const mode=layoutMode;applyLayout(positions.size?'keep':mode);layoutMode=mode;focus=null;selected=null;
    describe();
  }
  function visibleNativeNode(id){return !hiddenTypes.has(graph.getNodeAttribute(id,'type_label'))&&(!focus||neighbors(projection,focus).has(id));}
  function describe(){
    if(native){const visible=new Set(graph.nodes().filter(visibleNativeNode)),edges=projection.edges.filter(e=>visible.has(e.source)&&visible.has(e.target));
      setStatus(`当前显示 ${visible.size} / ${projection.total_nodes??graph.order} 个对象 · ${edges.length} / ${projection.total_edges??graph.size} 条关联`+(focus?' · 直连邻域视图':' · 概览')+(hiddenTypes.size?' · 已筛选类型':'')+(temporaryContext?' · 临时定位，可恢复此前图谱':'')+(projection.invalid?' · '+projection.invalid+' 项无法绑定未入图':'')+(selectionCanonical?.kind==='knowledge'&&!selectedObjects.size&&!selectedEdges.size?' · 当前知识未关联到可画对象':'')+(projection.edges.some(e=>e.parallel_count>1)?' · 多条真实关联分别绘制':'')+(lastPhysicsState.running?(lastPhysicsState.phase==='initial'?' · 布局调整中':lastPhysicsState.phase==='dragging'?' · 正在拖动':' · 布局回稳中'):''));return;}
    setStatus(projection.status_text?projection.status_text+(focus?' · 当前邻域 '+neighbors(projection,focus).size+' 个对象':''):`${projection.entities} 个实体 · ${projection.claims} 条${statementLabel} · 全图${graph.order}节点${focus?' · 当前邻域'+neighbors(projection,focus).size+'节点':''}${projection.omitted?' · 属性声明在详情栏':''}${projection.invalid?' · '+projection.invalid+'条无法绑定的声明未画出':''}`);
  }
  function syncSelection(){
    if(!native)return;
    const scope=container.closest?.('.native-domain-section')??container;
    scope.querySelectorAll?.('[data-action="native-domain-node"], [data-action="native-domain-relation"], [data-action="native-domain-knowledge"]').forEach(button=>{
      const kind=button.dataset.action==='native-domain-node'?'entity':button.dataset.action==='native-domain-knowledge'?'knowledge':'statement';
      const active=selectionCanonical?.id===button.dataset.id&&(selectionCanonical.kind===kind||(kind==='statement'&&selectionCanonical.kind==='relation'));
      if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
    });
    container.querySelectorAll?.('[data-graph-command="type"]').forEach(button=>button.setAttribute('aria-pressed',String(!hiddenTypes.has(button.dataset.type))));
  }
  function selectedNeighborhood(){return focus?neighbors(projection,focus):null;}
  function refresh(){if(!disposed)renderer?.refresh();}
  function frameSelection(id=selected){
    if(!id)return;physics?.stop('explicit-focus');focus=id;
    const points=[...neighbors(projection,focus)].filter(id=>graph.hasNode(id)).map(id=>graph.getNodeAttributes(id));
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),1),pad=span*.12;
    renderer.setCustomBBox({x:[Math.min(...xs)-pad,Math.max(...xs)+pad],y:[Math.min(...ys)-pad,Math.max(...ys)+pad]});
    refresh();renderer.getCamera().animate({x:.5,y:.5,ratio:1},{duration:240});describe();
  }
  function select(id,shouldFocus=false){
    if(!graph.hasNode(id))return;
    selected=id;selectedEdges.clear();selectedObjects.clear();if(shouldFocus)focus=id;
    const item=canonical(id);selectionCanonical=item;onSelect(item.id,item.kind);
    syncSelection();
    if(shouldFocus)frameSelection();
    refresh();
  }
  function selectSaved(id,kind='entity'){
    if(!native){const key=kind==='entity'?entityKey(id):claimKey(id);if(graph.hasNode(key)){selected=key;refresh();}return;}
    selected=null;hover=null;hoverEdge=null;selectedEdges.clear();selectedObjects.clear();selectionCanonical=id?{id,kind}:null;
    if(id&&kind==='entity'&&graph.hasNode(entityKey(id))){selected=entityKey(id);}
    else if(id&&(kind==='statement'||kind==='relation')){const edge=projection.edges.find(e=>e.canonical_id===id||e.id===id);if(edge){selectedEdges.add(edge.id);selectedObjects.add(edge.source);selectedObjects.add(edge.target);}}
    else if(id&&kind==='knowledge'){
      graph.forEachNode((key,a)=>{if(a.record_refs?.includes(id))selectedObjects.add(key);});
      graph.forEachEdge((key,a,source,target)=>{if(a.record_refs?.includes(id)){selectedEdges.add(key);selectedObjects.add(source);selectedObjects.add(target);}});
    }
    syncSelection();refresh();describe();publishDiagnostics();
  }
  function snapshot(){
    rememberPositions();
    const camera=renderer?.getCamera(),cameraState=camera?.getState?.()??camera;
    const saved={version:projection.version,nodes:graph.order,edges:graph.size,selected,focus,selection:clone(selectionCanonical),
      camera:Object.fromEntries(['x','y','angle','ratio'].filter(key=>finite(cameraState?.[key])).map(key=>[key,cameraState[key]])),
      custom_bbox:clone(renderer?.getCustomBBox?.()??null),positions:[...positions].filter(([id])=>graph.hasNode(id)).map(([id,p])=>({id,x:p.x,y:p.y})),
      layout_mode:layoutMode,paused,projection_focus:projectionFocusId,temporary_context:clone(temporaryContext),
      ...(native?{selected_edges:[...selectedEdges],selected_objects:[...selectedObjects],hidden_types:[...hiddenTypes]}:{})};if(native)container.setAttribute?.('data-graph-context',JSON.stringify(saved));return saved;
  }
  function restore(saved){
    // A saved camera/selection belongs to exactly one projection revision.
    // Changed or withdrawn sources must be handled by the caller, not silently rebound.
    if(!validContext(saved))return {restored:false,reason:'VERSION_MISMATCH'};
    stopFrame();physics?.stop('restored-context');
    if((saved.projection_focus??null)!==projectionFocusId)populate(true,{focusId:saved.projection_focus??null});
    importPositions(saved.positions);graph.forEachNode((id)=>{const p=positions.get(id);if(p)graph.mergeNodeAttributes(id,p);});
    layoutMode=['force','circle','keep'].includes(saved.layout_mode)?saved.layout_mode:layoutMode;
    paused=typeof saved.paused==='boolean'?saved.paused:paused;motion?.reset();
    hiddenTypes.clear();for(const type of saved.hidden_types??[])if(typeof type==='string')hiddenTypes.add(type);
    focus=graph.hasNode(saved.focus)?saved.focus:null;
    const selection=saved.selection;
    if(native)selectSaved(typeof selection?.id==='string'?selection.id:null,selection?.kind??'entity');
    else selected=graph.hasNode(saved.selected)?saved.selected:null;
    hover=null;hoverEdge=null;
    const bbox=saved.custom_bbox;
    if(bbox===null||['x','y'].every(axis=>Array.isArray(bbox?.[axis])&&bbox[axis].length===2&&bbox[axis].every(finite)))renderer.setCustomBBox(clone(bbox));
    const state=Object.fromEntries(['x','y','angle','ratio'].filter(key=>finite(saved.camera?.[key])&&(key!=='ratio'||saved.camera[key]>0)).map(key=>[key,saved.camera[key]]));
    if(Object.keys(state).length){const camera=renderer.getCamera();if(camera.setState)camera.setState(state);else Object.assign(camera,state);}
    temporaryContext=clone(saved.temporary_context??null);syncSelection();refresh();describe();schedule();publishDiagnostics();
    return {restored:true};
  }
  function locate(id,kind='entity',{focusId=null}={}){
    physics?.stop('explicit-location');const before=snapshot();
    selectSaved(id,kind);
    let targets=[selected,...selectedObjects].filter(Boolean),edgeIds=[...selectedEdges];
    if(!targets.length&&!edgeIds.length&&focusId){
      populate(true,{focusId});freezeBounds();selectSaved(id,kind);targets=[selected,...selectedObjects].filter(Boolean);edgeIds=[...selectedEdges];
    }
    if(!targets.length&&!edgeIds.length){restore(before);return {located:false,reason:'NO_GRAPH_ANCHOR',temporary:false};}
    const hidden=targets.some(key=>!visibleNativeNode(key)),reprojected=projectionFocusId!==before.projection_focus;
    if(hidden||reprojected){if(!temporaryContext)temporaryContext=before;for(const key of targets)hiddenTypes.delete(graph.getNodeAttribute(key,'type_label'));if(targets.some(key=>focus&&!neighbors(projection,focus).has(key)))focus=null;}
    const points=targets.map(key=>graph.getNodeAttributes(key)),xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    if(points.length){const span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),40),pad=span*.3;
      renderer.setCustomBBox({x:[Math.min(...xs)-pad,Math.max(...xs)+pad],y:[Math.min(...ys)-pad,Math.max(...ys)+pad]});renderer.getCamera().animate({x:.5,y:.5,ratio:1},{duration:240});}
    syncSelection();refresh();describe();publishDiagnostics();return {located:true,temporary:Boolean(temporaryContext)};
  }
  function focusObject(id=selectionCanonical?.kind==='entity'?selectionCanonical.id:null){
    if(typeof id!=='string')return {focused:false,reason:'NO_GRAPH_ANCHOR'};
    const before=snapshot(),key=entityKey(id);
    if(!graph.hasNode(key)){populate(true,{focusId:id});freezeBounds();}
    if(!graph.hasNode(key)){restore(before);return {focused:false,reason:'NO_GRAPH_ANCHOR'};}
    selectSaved(id,'entity');frameSelection(key);syncSelection();describe();
    return {focused:true,object_id:id};
  }
  populate(true);
  const nativeSettings=native?nativeRendererSettings():null;
  try{
    renderer=new Sigma(graph,surface,{
      renderEdgeLabels:true,enableEdgeEvents:true,zIndex:true,stagePadding:55,
      ...(labelTheme==='dark'?{defaultDrawNodeHover:drawDarkNodeHover}:{}),
      
      labelFont:'Geist, PingFang SC, sans-serif',labelSize:12,labelWeight:'400',labelColor:{color:'#d4e4da'},
      labelRenderedSizeThreshold:6,labelDensity:.35,labelGridCellSize:150,defaultEdgeColor:'#344a40',minCameraRatio:.06,maxCameraRatio:5,
      ...(nativeSettings??{}),
      nodeReducer:(id,a)=>{
        const res={...a},neighborhood=selectedNeighborhood(),active=hover||selected;
        if(native){
          if(!visibleNativeNode(id)){res.hidden=true;return res;}
          const edgeFocus=hoverEdge?new Set(graph.extremities(hoverEdge)):selectedObjects,hasFocus=!!active||edgeFocus.size>0,ratio=renderer?.getCamera().ratio??1;
          const isSelected=id===selected||selectedObjects.has(id),isHovered=id===hover,near=active?id===active||graph.hasEdge(id,active)||graph.hasEdge(active,id):edgeFocus.has(id);
          return nativeNodeVisual(a,{selected:isSelected,hovered:isHovered,neighbor:near||edgeFocus.has(id),hasFocus,hoverOnly:!!hover&&!selected&&!selectedObjects.size,ratio,nodeCount:graph.order});
        }
        if(neighborhood&&!neighborhood.has(id)){res.hidden=true;return res;}
        if(active){const near=id===active||graph.hasEdge(id,active)||graph.hasEdge(active,id);
          if(!near){res.color='#34443d';res.label='';res.zIndex=0;}else{res.zIndex=2;if(a.kind==='entity')res.highlighted=true;}}
        if(id===selected||id===hover){res.color='#d4ffe9';res.size=a.size+2;res.label=a.full_label;res.forceLabel=true;res.zIndex=4;}
        if(a.kind==='statement'&&id!==hover&&id!==selected&&renderer?.getCamera().ratio>.45)res.label='';
        // Sigma collision grid owns unselected labels; only the active subject is forced.
        if(a.kind==='entity'&&!active&&renderer?.getCamera().ratio>1.6)res.label='';
        return res;
      },
      edgeReducer:(id,a)=>{
        const res={...a},neighborhood=selectedNeighborhood(),active=hover||selected;
        if(native){
          if(!visibleNativeNode(a.source)||!visibleNativeNode(a.target)){res.hidden=true;return res;}
          const picked=selectedEdges.has(id)||hoverEdge===id,near=!!active&&(a.source===active||a.target===active),hasFocus=!!active||selectedObjects.size>0||!!hoverEdge;
          return nativeEdgeVisual(a,{picked,near,hasFocus,hoverOnly:!!hover&&!selected&&!selectedEdges.size,ratio:renderer?.getCamera().ratio??1,edgeCount:graph.size});
        }
        if(neighborhood&&(!neighborhood.has(a.source)||!neighborhood.has(a.target)))res.hidden=true;
        res.label=edgeLabels==='auto'&&(!active||a.source===active||a.target===active)&&renderer?.getCamera().ratio<1.5?a.label:'';
        if(active&&(a.source===active||a.target===active)){res.color=a.planned?'#d5b47e':'#9ce7c8';res.size=1.2;res.zIndex=3;
          if(renderer?.getCamera().ratio<(edgeLabels==='auto'?2:.45))res.label=a.label;}
        return res;
      }
    });
  }catch(error){setStatus('无法启动交互画布：'+error.message+'。请使用支持WebGL的浏览器；知识和证据仍保留。');throw error;}
  const beginLabelFrame=()=>{if(nativeSettings)resetNativeLabelLayout(nativeSettings.nativeLabelLayout);};renderer.on('beforeRender',beginLabelFrame);
  if(!native)motion=createGraphMotion(graph);
  const freezeBounds=()=>renderer.setCustomBBox(renderer.getBBox());
  freezeBounds();
  function paintHalo(){
    if(!halo)return;
    const ctx=halo.getContext('2d');if(!ctx)return;
    const width=surface.clientWidth,height=surface.clientHeight,dpr=Math.min(globalThis.devicePixelRatio||1,2);
    if(halo.width!==width*dpr||halo.height!==height*dpr){halo.width=width*dpr;halo.height=height*dpr;}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    const neighborhood=selectedNeighborhood();
    graph.forEachNode((id,a)=>{
      if(neighborhood&&!neighborhood.has(id))return;
      if(native&&!visibleNativeNode(id))return;
      const p=renderer.graphToViewport(a),born=previousIds.size&&!previousIds.has(id)&&!reduced?.matches?Math.max(0,1-(Date.now()-birthTime)/1800):0;
      if(native){
        const active=id===hover||id===selected||selectedObjects.has(id)||(hoverEdge&&graph.extremities(hoverEdge).includes(id)),radius=renderer.scaleSize(a.size)+(active?1:0);
        // Crisp shells and a small selection ring replace the full-screen glow.
        ctx.beginPath();ctx.arc(p.x,p.y,radius+2,0,Math.PI*2);ctx.strokeStyle='#14261b';ctx.lineWidth=3;ctx.stroke();
        ctx.beginPath();ctx.arc(p.x,p.y,radius+(active?5:2.5),0,Math.PI*2);ctx.strokeStyle=active?'#c0edcf':a.color+'66';ctx.lineWidth=active?1.5:1;ctx.stroke();
        return;
      }
      if(born){ctx.strokeStyle='rgba(156,231,200,'+(born*.65)+')';ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,renderer.scaleSize(a.size)+4+(1-born)*20,0,Math.PI*2);ctx.stroke();}
      if(a.kind!=='entity')return;
      const radius=renderer.scaleSize(a.size)*(id===hover||id===selected?4:3);
      if(p.x< -radius||p.y< -radius||p.x>width+radius||p.y>height+radius)return;
      const gradient=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,radius);
      gradient.addColorStop(0,a.color+'35');gradient.addColorStop(.35,a.color+'14');gradient.addColorStop(1,a.color+'00');
      ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fill();
    });
  }
  if(!native&&typeof document!=='undefined'&&surface.prepend){halo=document.createElement('canvas');halo.className='graph-halos';halo.setAttribute('aria-hidden','true');surface.prepend(halo);renderer.on('afterRender',paintHalo);}
  function schedule(){
    if(disposed||frame!==null||!motionAllowed()||typeof requestAnimationFrame!=='function'||(typeof document!=='undefined'&&document.hidden))return;
    frame=requestAnimationFrame(tick);
  }
  function tick(time){
    frame=null;if(disposed||!motionAllowed())return;
    if(lastTime&&time-lastTime<30){schedule();return;}
    motion.step(time,lastTime?time-lastTime:16.667);lastTime=time;schedule();
  }
  function stopFrame(){if(frame!==null){cancelAnimationFrame(frame);frame=null;}lastTime=0;}
  const visibility=()=>{stopFrame();if(native){if(reduced?.matches||typeof document!=='undefined'&&document.hidden)physics?.stop('motion-disabled');}else schedule();};
  reduced?.addEventListener('change',visibility);
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',visibility);
  function releaseDrag(){
    const wasDragging=dragging;if(wasDragging)suppressClickUntil=Date.now()+200;
    dragged=null;dragOrigin=null;if(native){if(wasDragging)physics?.endDrag();}else motion?.release();surface.style.cursor='grab';
    rememberPositions();publishDiagnostics();queueMicrotask(()=>{dragging=false;});
  }
  if(typeof window!=='undefined'){window.addEventListener('mouseup',releaseDrag);window.addEventListener('blur',releaseDrag);}
  schedule();
  renderer.on('clickNode',({node})=>{if(!dragging&&Date.now()>suppressClickUntil)select(node);});
  renderer.on('doubleClickNode',({node,event})=>{event.preventSigmaDefault();select(node,true);});
  renderer.on('clickEdge',({edge})=>{
    if(native){const id=graph.getEdgeAttribute(edge,'canonical_id');selectSaved(id,'statement');onSelect(id,'statement');return;}
    const id=graph.getEdgeAttribute(edge,'statement_id')??graph.getEdgeAttribute(edge,'claim_id');onSelect(id,'statement');
  });
  if(native){renderer.on('enterEdge',({edge})=>{hoverEdge=edge;surface.style.cursor='pointer';refresh();});renderer.on('leaveEdge',()=>{hoverEdge=null;surface.style.cursor='grab';refresh();});}
  renderer.on('enterNode',({node})=>{hover=node;surface.style.cursor='pointer';refresh();});
  renderer.on('leaveNode',()=>{hover=null;surface.style.cursor='grab';refresh();});
  renderer.on('downNode',({node,event})=>{dragged=node;dragging=false;dragOrigin=event&&finite(event.x)&&finite(event.y)?{x:event.x,y:event.y}:null;surface.style.cursor='grabbing';if(!native){const a=graph.getNodeAttributes(node);motion.pin(node,a.x,a.y);if(!renderer.getCustomBBox())freezeBounds();}});
  const captor=renderer.getMouseCaptor();
  captor.on('mousemovebody',event=>{if(!dragged)return;if(native&&!dragging&&dragOrigin&&Math.hypot(event.x-dragOrigin.x,event.y-dragOrigin.y)<4)return;const p=renderer.viewportToGraph(event);if(native){if(!dragging){if(!renderer.getCustomBBox())freezeBounds();physics?.beginDrag(dragged,p);}else physics?.moveDrag(p);}else{motion.pin(dragged,p.x,p.y);graph.mergeNodeAttributes(dragged,p);}dragging=true;positions.set(dragged,p);event.preventSigmaDefault();event.original.preventDefault();event.original.stopPropagation();publishDiagnostics();});
  captor.on('mouseup',releaseDrag);
  renderer.on('clickStage',()=>{if(!dragging&&Date.now()>suppressClickUntil){if(native)selectSaved(null);selected=null;if(!native)focus=null;onSelect(null,null);refresh();describe();}});
  const click=event=>{
    const button=event.target.closest('[data-graph-command]');if(!button)return;
    const command=button.dataset.graphCommand,camera=renderer.getCamera();
    if(native&&command==='copy-source'){
      const text=button.closest('.native-domain-evidence')?.querySelector('[data-source-quote]')?.textContent;
      if(text&&typeof navigator!=='undefined'&&navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(()=>{button.textContent='已复制';},()=>{button.textContent='请选中文字复制';});
      else button.textContent='请选中文字复制';
      return;
    }
    if(native&&command==='type'){if(hiddenTypes.has(button.dataset.type))hiddenTypes.delete(button.dataset.type);else hiddenTypes.add(button.dataset.type);syncSelection();refresh();describe();publishDiagnostics();return;}
    if(native&&command==='reset-types'){hiddenTypes.clear();syncSelection();refresh();describe();publishDiagnostics();return;}
    if(command==='in')camera.animatedZoom({duration:180});
    if(command==='out')camera.animatedUnzoom({duration:180});
    if(command==='fit'){if(!native)focus=null;if(focus)frameSelection(focus);else freezeBounds();camera.animatedReset({duration:220});refresh();}
    if(command==='focus'&&selected)frameSelection();
    if(command==='unfocus'){focus=null;freezeBounds();camera.animatedReset({duration:220});refresh();}
    if(command==='layout'){applyLayout('force');freezeBounds();camera.animatedReset({duration:220});refresh();if(native)physics?.startInitial();else schedule();}
    if(command==='circle'){physics?.stop('layout-change');applyLayout('circle');stopFrame();freezeBounds();camera.animatedReset({duration:220});refresh();}
    if(command==='motion'){if(native){if(physics?.isRunning())physics.stop('manual-stop');else physics?.startInitial();return;}paused=!paused;button.textContent=paused?'开启动效':'暂停动效';button.setAttribute('aria-pressed',String(paused));if(paused)stopFrame();else schedule();}
    if(command==='entity')select(entityKey(button.dataset.entity),true);
    describe();publishDiagnostics();
  };
  const change=event=>{
    if(event.type==='change'&&event.target.matches('[data-graph-statements]')){populate(event.target.checked);freezeBounds();renderer.getCamera().animatedReset({duration:200});refresh();schedule();}
    if(event.type==='input'&&event.target.matches('[data-graph-search]')){
      const value=event.target.value.trim().toLocaleLowerCase();
      container.querySelectorAll('[data-graph-command="entity"]').forEach(button=>{button.hidden=!button.textContent.toLocaleLowerCase().includes(value);});
    }
  };
  container.addEventListener('click',click);container.addEventListener('input',change);container.addEventListener('change',change);
  surface.style.cursor='grab';
  function publishDiagnostics(){
    if(!native||!renderer||!projection||disposed)return;
    const state=snapshot();container.setAttribute?.('data-graph-context',JSON.stringify(state));
    container.setAttribute?.('data-graph-layout',JSON.stringify(lastPhysicsState));
  }
  if(native){
    grid=createGraphWorldGrid(surface,renderer);
    physics=createGraphFA2Layout(graph,{settings:graphFA2Settings(graph),reducedMotion:()=>!!reduced?.matches,isHidden:()=>typeof document!=='undefined'&&document.hidden,layoutMode:()=>layoutMode,
      onTick:state=>{lastPhysicsState=state;container.setAttribute?.('data-graph-layout',JSON.stringify(state));refresh();},
      onState:state=>{lastPhysicsState=state;layoutHistory.push({...state,at:Date.now()});if(layoutHistory.length>16)layoutHistory.shift();container.setAttribute?.('data-graph-layout-history',JSON.stringify(layoutHistory));if(state.reason==='initial-settled'&&renderer.getCustomBBox()===null)freezeBounds();describe();publishDiagnostics();},
      onError:error=>{setStatus('画布布局暂未继续，当前图与位置已保留。');container.setAttribute?.('data-graph-layout-error',error.code??error.message);}});
  }
  if(context)restore(context);
  const cameraUpdated=()=>publishDiagnostics();renderer.getCamera().on?.('updated',cameraUpdated);
  if(native){if(initialLayoutPrepared&&!validContext(context)&&!reduced?.matches){renderer.setCustomBBox(null);physics.startInitial();}publishDiagnostics();}
  return {select:selectSaved,locate,restore,snapshot,focus:focusObject,
    restoreLocation(){if(!temporaryContext)return {restored:false,reason:'NO_TEMPORARY_LOCATION'};const saved=temporaryContext;temporaryContext=null;return restore(saved);},
    dispose(){physics?.dispose();disposed=true;stopFrame();grid?.dispose();renderer.removeListener('beforeRender',beginLabelFrame);renderer.getCamera().removeListener?.('updated',cameraUpdated);graph.forEachNode((id,a)=>positions.set(id,{x:a.x,y:a.y}));layoutMemory.delete(layoutKey);layoutMemory.set(layoutKey,new Map([...positions].slice(-1800)));if(layoutMemory.size>8)layoutMemory.delete(layoutMemory.keys().next().value);reduced?.removeEventListener('change',visibility);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visibility);if(typeof window!=='undefined'){window.removeEventListener('mouseup',releaseDrag);window.removeEventListener('blur',releaseDrag);}container.removeEventListener('click',click);container.removeEventListener('input',change);container.removeEventListener('change',change);halo?.remove();renderer.kill();},
    };
}
