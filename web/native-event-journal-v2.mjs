/** A recoverable notification journal and bounded, ordered PG commits.
 * Provider bodies and lifecycle ledgers keep their existing synchronous paths.
 */
import {openSync, closeSync, writeSync, fsyncSync, mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {hash} from './cq-discovery-store-v2.mjs';

export const NATIVE_EVENT_RECORD = 'native_agent_event_v1';
export const NATIVE_EVENT_SEGMENT = 'native_agent_event_segment_v2';
const MAX_EVENTS = 128;
const MAX_BYTES = 262144;
const FLUSH_MS = 50;
const sha = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(Error(code), {code});
const DELTA_METHODS = new Set([
  'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
]);
const isDelta = record => record.type === 'RUNTIME_NOTIFICATION' && DELTA_METHODS.has(record.notification?.method);

export function createNativeEventJournal({store, runtimeDirectory, invocationRef, onError = () => {}}) {
  const directory = resolve(runtimeDirectory);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const journalPath = join(directory, 'events-' + invocationRef + '.jsonl');
  const fd = openSync(journalPath, 'wx', 0o600);
  let sequence = 0;
  let offset = 0;
  let committed = 0;
  let previous = null;
  let pending = [];
  let bytes = 0;
  let timer = null;
  let closed = false;
  let poisoned = false;
  let totalFlushMs = 0;
  let lastFlushAt = null;
  let segments = 0;

  const summary = () => ({
    contract: 'native-event-log/2', journal_path: journalPath, observed_events: sequence,
    persisted_events: committed, pending_events: pending.length, segments, last_segment_sha256: previous,
    journal_bytes: offset, max_buffer_events: MAX_EVENTS, max_buffer_bytes: MAX_BYTES, flush_interval_ms: FLUSH_MS,
    flush_wall_ms: totalFlushMs, last_flush_at: lastFlushAt,
    status: poisoned ? 'PERSISTENCE_UNKNOWN' : committed === sequence ? 'CONFIRMED' : 'PENDING_TAIL',
  });

  function flush() {
    if (poisoned) throw error('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN');
    clearTimeout(timer);
    timer = null;
    if (!pending.length) return summary();
    const started = performance.now();
    const records = pending.map(item => item.record);
    const body = {
      contract: 'native-event-segment/2', invocation_ref: invocationRef, journal_path: journalPath,
      first_sequence: records[0].event_sequence, last_sequence: records.at(-1).event_sequence,
      count: records.length, journal_start: pending[0].start, journal_end: offset,
      journal_sha256: sha(Buffer.concat(pending.map(item => item.line))),
      event_rows_sha256: hash(records), previous_segment_sha256: previous,
    };
    const segment = {...body, segment_sha256: hash(body)};
    const rows = [...records.map(record => ({kind: NATIVE_EVENT_RECORD, key: record.event_ref, payload: record})),
      {kind: NATIVE_EVENT_SEGMENT, key: invocationRef + ':' + body.first_sequence, payload: segment}];
    try {
      fsyncSync(fd);
      if (typeof store.putRecords === 'function') store.putRecords(rows);
      else store.transaction(() => {
        for (const row of rows) store.putRecord(row.kind, row.key, row.payload);
      });
    } catch {
      poisoned = true;
      throw error('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN');
    }
    committed = sequence;
    previous = segment.segment_sha256;
    segments++;
    pending = [];
    bytes = 0;
    totalFlushMs += performance.now() - started;
    lastFlushAt = Date.now();
    return summary();
  }

  function append(value) {
    if (closed || poisoned) throw error('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN');
    const record = {...value, event_sequence: ++sequence};
    const line = Buffer.from(JSON.stringify({sequence, record, record_sha256: hash(record)}) + '\n');
    // Oversized individual notices are committed alone. The buffer never grows
    // beyond its byte bound merely to collect another event.
    if (pending.length && bytes + line.length > MAX_BYTES) {
      sequence--;
      flush();
      sequence++;
    }
    const start = offset;
    try {
      let written = 0;
      while (written < line.length) written += writeSync(fd, line, written);
      offset += line.length;
    } catch {
      poisoned = true;
      throw error('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN');
    }
    pending.push({record, line, start});
    bytes += line.length;
    if (!isDelta(record) || pending.length >= MAX_EVENTS || bytes >= MAX_BYTES) flush();
    else if (!timer) {
      timer = setTimeout(() => {
        try { flush(); } catch { onError('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN'); }
      }, FLUSH_MS);
      timer.unref();
    }
    return record;
  }

  function close() {
    if (closed) return summary();
    try {
      flush();
      const seal = {contract: 'native-event-log-seal/2', invocation_ref: invocationRef,
        journal_bytes: offset, observed_events: sequence, last_segment_sha256: previous};
      const sealFd = openSync(journalPath + '.seal.json', 'wx', 0o600);
      try {
        const bytes = Buffer.from(JSON.stringify({...seal, seal_sha256: hash(seal)}) + '\n');
        let written = 0;
        while (written < bytes.length) written += writeSync(sealFd, bytes, written);
        fsyncSync(sealFd);
      } finally {
        closeSync(sealFd);
      }
    } catch {
      poisoned = true;
      throw error('NATIVE_EVENT_LOG_PERSISTENCE_UNKNOWN');
    } finally {
      clearTimeout(timer);
      timer = null;
      closed = true;
      closeSync(fd);
    }
    return summary();
  }
  return {append, flush, close, summary};
}

/** Read-only crash diagnosis. Never replays provider requests or business tools. */
export function inspectNativeEventJournal(path, persistedSegments = []) {
  const raw = readFileSync(path);
  const lines = raw.toString('utf8').split('\n');
  const trailing = lines.pop();
  const records = [];
  let expected = 1;
  for (const line of lines) {
    const item = JSON.parse(line);
    if (item.sequence !== expected++ || item.record.event_sequence !== item.sequence ||
        item.record_sha256 !== hash(item.record)) throw error('NATIVE_EVENT_JOURNAL_CORRUPT');
    records.push(item.record);
  }
  let committed = 0;
  let prior = null;
  const segments = [...persistedSegments].sort((a, b) => a.first_sequence - b.first_sequence);
  for (const segment of segments) {
    const {segment_sha256: digest, ...body} = segment;
    if (digest !== hash(body) || segment.first_sequence !== committed + 1 ||
        segment.previous_segment_sha256 !== prior ||
        segment.count !== segment.last_sequence - segment.first_sequence + 1 ||
        segment.event_rows_sha256 !== hash(records.slice(segment.first_sequence - 1, segment.last_sequence)) ||
        segment.journal_sha256 !== sha(raw.subarray(segment.journal_start, segment.journal_end))) {
      throw error('NATIVE_EVENT_SEGMENT_CORRUPT');
    }
    committed = segment.last_sequence;
    prior = digest;
  }
  let sealed = false;
  try {
    const {seal_sha256: digest, ...seal} = JSON.parse(readFileSync(path + '.seal.json', 'utf8'));
    if (digest !== hash(seal) || seal.journal_bytes !== raw.length || seal.observed_events !== records.length) {
      throw error('NATIVE_EVENT_SEAL_CORRUPT');
    }
    sealed = true;
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw failure;
  }
  const gaps = [];
  if (trailing) gaps.push({reason_code: 'EVENT_JOURNAL_INCOMPLETE_TAIL', after_sequence: records.length});
  if (!sealed) gaps.push({reason_code: 'NATIVE_NOTIFICATION_TAIL_UNCONFIRMED', after_sequence: records.length});
  return {
    contract: 'native-event-log-inspection/2', complete_journal_events: records.length, persisted_events: committed,
    recoverable_tail: records.slice(committed), incomplete_trailing_bytes: Buffer.byteLength(trailing), sealed,
    gaps, status: trailing ? 'TAIL_GAP' : committed < records.length ? 'RECOVERABLE_JOURNAL_TAIL' :
      sealed ? 'CONFIRMED' : 'UNSEALED_NATIVE_TAIL',
    business_completion_claimed: false,
  };
}
