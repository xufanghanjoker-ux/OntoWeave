/** S0 candidate copy. Production and earlier frozen candidate unchanged. */
/** Server composition: real action Host + real graph/index projection + one automatic local worker. */
import {createMemoryRecordCore} from './native-memory-record-core-v1.mjs';
import {createMemoryProductService} from './native-memory-product-service-v1.mjs';
import {createMemoryProcessing} from './native-memory-processing-v1.mjs';
import {createMemoryPublicationCoordinator} from './native-memory-publication-v1.mjs';
import {createMemoryProductProjection} from './native-memory-product-projection-v1.mjs';
import {createMemoryPreparedQualityReader} from './native-memory-processing-quality-v1.mjs';
import {createNativeActionServiceProcessor} from './native-action-service-processor-v1.mjs';
import {createNativeExtractedQueryReader} from './native-query-extracted-reader-v1.mjs';
import {createMemoryKnowledgeSearchPort} from './native-query-extracted-reader-memory-port-v1.mjs';
import {need, hash} from './cq-discovery-store-v2.mjs';
import {createTemporalFactParticipant} from './native-temporal-sqlite-v2.mjs';
import {createMemoryTemporalProduct} from './native-memory-temporal-product-v2.mjs';

export function createMemoryProductRuntime({store, catalog = null, authorize, actionProcessingPort = null,
  actionProcessingPortFactory = null, modelRuntime = null,
  embed = null, embeddingSpace = null, capability = 'HYBRID', readerFactory = createNativeExtractedQueryReader,
  searchPortFactory = createMemoryKnowledgeSearchPort, processorFactory = createNativeActionServiceProcessor,
  onOperation = () => {}, assertLibrary = () => {}, resumeNeverStarted = true, clock,
  executionLabel = 'HOST_CONFIGURED_EMBEDDING', cursorSecret, verifyActionPrepared, prepareActionLibrary, temporalCore = null,temporalEmbeddingRuntime=null}) {
  need(store?.db && typeof authorize === 'function' && typeof readerFactory === 'function', 'MEMORY_RUNTIME_HOST_REQUIRED');
  need(modelRuntime === null || typeof modelRuntime === 'function', 'MEMORY_RUNTIME_MODEL_GETTER_INVALID');
  const configured = () => modelRuntime ? modelRuntime() : {embed, embeddingSpace};
  const modelsReady = () => {
    try {const value = configured(); return !!((actionProcessingPort || typeof actionProcessingPortFactory === 'function' && typeof value?.upstream === 'function')
      && (capability === 'LEXICAL' || value?.embed && value?.embeddingSpace));} catch {return false;}
  };
  const cores = new Map(), coreForLibrary = libraryId => {
    if (!cores.has(libraryId)) cores.set(libraryId, createMemoryRecordCore({db: store.db, libraryId, ...(clock ? {clock} : {})}));
    return cores.get(libraryId);
  };
  const projection = createMemoryProductProjection({store, coreForLibrary, catalog, embed, embeddingSpace,
    embeddingRuntime: configured, capability, executionLabel,
    ...(verifyActionPrepared?{verifyActionPrepared}:{}),...(prepareActionLibrary?{prepareActionLibrary}:{})});
  need(temporalCore===null||typeof temporalCore==='function','MEMORY_RUNTIME_TEMPORAL_CORE_INVALID');
  const temporalParticipant=temporalCore?createTemporalFactParticipant({store,core:temporalCore,rawCoreForLibrary:coreForLibrary,
    authorize:({library_id})=>{assertLibrary(library_id);return true;},preserveExisting:true,catalog:projection.catalog,
    embeddingRuntime:temporalEmbeddingRuntime,...(clock?{clock}:{})}):null;
  const publication = createMemoryPublicationCoordinator({db: store.db, coreForLibrary, projectionPort: projection,
    ...(temporalParticipant?{factPort:temporalParticipant.factPort}:{}),...(clock ? {clock} : {})});
  temporalParticipant?.attachCoordinator(publication);
  const temporalPort=temporalParticipant?createMemoryTemporalProduct({store,participant:temporalParticipant,coreForLibrary,
    catalog:projection.catalog,assertLibrary}):null;
  const hasProcessor = actionProcessingPort || typeof actionProcessingPortFactory === 'function';
  const processorPort = hasProcessor ? {
    mode: actionProcessingPort?.execution_mode === 'DI_SCRIPTED' ? 'OFFLINE_DI' : 'NATIVE_CODEX',
    isReady: modelsReady,
    async process(args) {
      const snapshot = configured();
      const processingPort = actionProcessingPortFactory ? actionProcessingPortFactory(snapshot) : actionProcessingPort;
      const delegate = processorFactory({processingPort, resolveContext: projection.resolveContext,
        prepareProjection: input => projection.prepareProjection({...input, embeddingSnapshot: snapshot})});
      return delegate.process(args);
    }
  } : null;
  const resolveProcessingQuality=createMemoryPreparedQualityReader({store,verifyPrepared:verifyActionPrepared??null});
  const processing = createMemoryProcessing({db: store.db, coreForLibrary, processorPort, publication,resolveProcessingQuality,
    ...(clock ? {clock} : {})});
  const rawRecordPort = {getRawRecord({library_id, record_ref}) {assertLibrary(library_id); return coreForLibrary(library_id).getRawRecord(record_ref);}};
  const resolveReader = libraryId => {
    assertLibrary(libraryId);
    return readerFactory({store, libraryId, catalog: projection.catalog, publication, rawRecordPort});
  };
  const searchPort = searchPortFactory({resolveReader, embed});
  function readCurrentView({library_id}) {
    assertLibrary(library_id);
    const before = publication.assertQueryable({library_id});
    const result = projection.readCurrentView({library_id, publicationView: before});
    need(hash(publication.assertQueryable({library_id})) === hash(before), 'MEMORY_CURRENT_VIEW_STALE');
    return result;
  }
  let closed = false, running = false, scheduled = false;
  const queue = [], queued = new Set(), waiters = [], errors = [];
  const settle = () => {if (!running && !queue.length && !scheduled) while (waiters.length) waiters.shift()();};
  function remember(cause, job) {
    errors.push({job_ref: job.job_ref, code: cause.code ?? 'MEMORY_WORKER_FAILED'});
    if (errors.length > 20) errors.shift();
  }
  async function work() {
    scheduled = false;
    if (closed || running) {settle(); return;}
    const job = queue.shift(); if (!job) {settle(); return;}
    queued.delete(job.job_ref); running = true;
    let counted = false;
    try {
      assertLibrary(job.library_id);
      onOperation(1); counted = true;
      await processing.runOne({job_ref: job.job_ref});
    } catch (cause) {remember(cause, job);}
    finally {
      if (counted) {try {onOperation(-1);} catch (cause) {remember(cause, job);}}
      running = false;
      schedule(); settle();
    }
  }
  function schedule() {
    if (closed || running || scheduled || !queue.length) return;
    scheduled = true; setImmediate(work);
  }
  function notifyEnqueued(job) {
    if (closed || !processorPort || !modelsReady() || queued.has(job.job_ref) || job.attempts !== 0
      || !['QUEUED', 'WAITING_PROCESSOR', 'WAITING_MODEL'].includes(job.state)) return;
    queued.add(job.job_ref); queue.push(job); schedule();
  }
  const service = createMemoryProductService({db: store.db, authorize, processing, publication, searchPort,temporalPort,
    ...(clock ? {clock} : {}), ...(cursorSecret ? {cursorSecret} : {}), notifyEnqueued});
  const drain = () => !running && !queue.length && !scheduled ? Promise.resolve() : new Promise(resolve => waiters.push(resolve));
  function resume() {
    if (!processorPort || closed) return;
    for (const job of processing.neverStarted({limit: 100})) notifyEnqueued(job);
  }
  if (resumeNeverStarted) resume();
  return Object.freeze({service, processing, publication, projection, searchPort, resolveReader, rawRecordPort, readCurrentView,temporalParticipant,temporalPort,
    coreForLibrary, catalog: projection.catalog, notifyEnqueued, resumeNeverStarted: resume, drain,
    async close({drain: finish = true} = {}) {
      if (finish) await drain();
      closed = true; queue.length = 0; queued.clear(); settle();
    },
    readiness: () => ({...service.readiness(), production_mount_ready: !closed && service.readiness().production_mount_ready && modelsReady(),
      models_configured: modelsReady(), automatic_processing: !!processorPort && !closed, closed,
      execution_mode: processorPort?.mode === 'NATIVE_CODEX' ? 'NATIVE_CODEX' : actionProcessingPort?.execution_mode ?? 'UNAVAILABLE', queue_length: queue.length,
      running, errors: [...errors], strict_as_of_supported: false})});
}
