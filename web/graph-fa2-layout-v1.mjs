/** Bounded real ForceAtlas2 computation in an external, same-origin worker. */
import forceAtlas2 from 'graphology-layout-forceatlas2';
import defaults from 'graphology-layout-forceatlas2/defaults.js';
import helpers from 'graphology-layout-forceatlas2/helpers.js';
import getters from 'graphology-utils/getters.js';

export const GRAPH_FA2_INITIAL_MS = 2500;
export const GRAPH_FA2_SETTLE_MS = 1200;
export const GRAPH_FA2_WORKER_URL = '/assets/graph-fa2-worker-v1.mjs';

/** The same complete settings serve synchronous seeding and worker iterations. */
export function graphFA2Settings(graph) {
  const order = Math.max(1, typeof graph === 'number' ? graph : graph.order);
  return {...defaults, ...forceAtlas2.inferSettings(order), gravity: .35,
    scalingRatio: 22, outboundAttractionDistribution: true};
}

/**
 * Coordinates belong to graph. This controller never changes topology or camera.
 * A stopped worker is terminated, so a late result cannot enter a later run.
 */
export function createGraphFA2Layout(graph, {
  settings = graphFA2Settings(graph),
  workerFactory = () => new Worker(GRAPH_FA2_WORKER_URL),
  setTimer = setTimeout, clearTimer = clearTimeout,
  reducedMotion = () => false, isHidden = () => false,
  layoutMode = () => 'force', onTick = () => {}, onState = () => {}, onError = () => {},
} = {}) {
  const selected = {...defaults, ...settings}, invalid = helpers.validateSettings(selected);
  if (invalid) throw Error('GRAPH_FA2_SETTINGS_INVALID: ' + invalid.message);
  const getEdgeWeight = getters.createEdgeWeightGetter('weight').fromEntry;
  let worker = null, matrices = null, epoch = 0, timer = null, timerEpoch = 0;
  let running = false, disposed = false, phase = 'idle', reason = null, iterations = 0, pin = null;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const state = () => ({running, phase, reason, iterations, dragged: pin?.node ?? null});
  const emit = () => onState(state());
  const clearStopTimer = () => {timerEpoch++;if (timer !== null) {clearTimer(timer); timer = null;}};
  const allowed = () => !disposed && layoutMode() === 'force' && !reducedMotion() && !isHidden() && graph.order > 0;
  function stop(why = 'stopped') {
    clearStopTimer(); epoch++;
    running = false; reason = why; phase = disposed ? 'disposed' : 'idle';
    const previous = worker; worker = null; matrices = null;
    previous?.terminate(); emit();
  }
  function fail(error) {
    stop('worker-error');
    onError(Object.assign(error instanceof Error ? error : Error(String(error)), {code:'GRAPH_FA2_WORKER_FAILED'}));
  }
  function ask(withEdges = false) {
    if (!running || !worker || !matrices) return;
    const payload = {settings:selected, nodes:matrices.nodes.buffer};
    const buffers = [payload.nodes];
    if (withEdges) {payload.edges = matrices.edges.buffer; buffers.push(payload.edges);}
    worker.postMessage(payload, buffers);
  }
  function start(nextPhase) {
    if (!allowed()) {stop(disposed ? 'disposed' : 'motion-disabled'); return false;}
    if (running) {phase = nextPhase; reason = null; emit(); return true;}
    const nodes = graph.nodes();
    if (nodes.some(node => {const a=graph.getNodeAttributes(node); return !finite(a.x)||!finite(a.y);})) {
      fail(Error('GRAPH_FA2_COORDINATES_INVALID')); return false;
    }
    const runEpoch = ++epoch;
    try {
      matrices = helpers.graphToByteArrays(graph, getEdgeWeight);
      const active = workerFactory(); worker = active;
      const message = event => {
        if (disposed || !running || active !== worker || runEpoch !== epoch) return;
        if (!allowed()) {stop('motion-disabled'); return;}
        try {
          const matrix = new Float32Array(event.data.nodes);
          const actualNodes=graph.nodes();
          if (matrix.length !== graph.order * 10 || nodes.length !== graph.order || nodes.some((id,i)=>actualNodes[i]!==id)) throw Error('GRAPH_FA2_TOPOLOGY_CHANGED');
          for (let i=0;i<matrix.length;i+=10) if (!finite(matrix[i])||!finite(matrix[i+1])) throw Error('GRAPH_FA2_RESULT_INVALID');
          helpers.assignLayoutChanges(graph, matrix, (node, attributes) => pin?.node===node ? {...attributes, x:pin.x, y:pin.y} : attributes);
          // Pointer changes on the UI thread feed the next official FA2 iteration.
          helpers.readGraphPositions(graph, matrix);
          matrices.nodes = matrix; iterations++; onTick(state()); ask();
        } catch(error) {fail(error);}
      };
      active.addEventListener('message', message);
      active.addEventListener('error', event => {if(active===worker&&runEpoch===epoch)fail(Error(event?.message??'GRAPH_FA2_WORKER_ERROR'));});
      running = true; phase = nextPhase; reason = null; emit(); ask(true);
      return true;
    } catch(error) {fail(error); return false;}
  }
  function stopAfter(duration, why) {
    clearStopTimer();
    if (!running) return;
    const deadlineEpoch=timerEpoch;
    timer=setTimer(()=>{if(deadlineEpoch!==timerEpoch)return;timer=null;stop(why);},duration);
  }
  const topologyChanged = () => {pin=null;stop('topology-changed');};
  for (const event of ['nodeAdded','edgeAdded','nodeDropped','edgeDropped','cleared','edgesCleared']) graph.on(event,topologyChanged);
  return {
    settings:{...selected},
    isRunning:()=>running,
    snapshot:state,
    startInitial({restored=false}={}) {
      clearStopTimer();
      if(restored){pin=null;stop('restored-context');return false;}
      const started=start('initial'); if(started)stopAfter(GRAPH_FA2_INITIAL_MS,'initial-settled'); return started;
    },
    beginDrag(node,position) {
      if(disposed||!graph.hasNode(node)||!finite(position?.x)||!finite(position?.y))return false;
      clearStopTimer(); pin={node,x:position.x,y:position.y};
      graph.mergeNodeAttributes(node,{x:pin.x,y:pin.y});
      return start('dragging');
    },
    moveDrag(position) {
      if(disposed||!pin||!finite(position?.x)||!finite(position?.y))return false;
      pin={...pin,x:position.x,y:position.y};graph.mergeNodeAttributes(pin.node,{x:pin.x,y:pin.y});return true;
    },
    endDrag() {
      if(!pin)return false;
      pin=null;clearStopTimer();
      if(!allowed()){stop('motion-disabled');return false;}
      const started=start('settling');if(started)stopAfter(GRAPH_FA2_SETTLE_MS,'drag-settled');return started;
    },
    stop(why='stopped'){pin=null;stop(why);},
    dispose(){if(disposed)return;disposed=true;pin=null;stop('disposed');for(const event of ['nodeAdded','edgeAdded','nodeDropped','edgeDropped','cleared','edgesCleared'])graph.removeListener(event,topologyChanged);},
  };
}
