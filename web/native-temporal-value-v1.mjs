/** Business time values only. This module never reads a clock or chooses a knowledge version. */
const TIME_KINDS = new Set(['INSTANT', 'INTERVAL', 'UNRESOLVED', 'TIMELESS']);
const PRECISIONS = new Set(['MILLISECOND', 'SECOND', 'MINUTE', 'DAY', 'MONTH', 'YEAR']);
const ENDPOINT_KINDS = new Set(['KNOWN', 'UNKNOWN', 'OPEN_AS_REPORTED', 'UNKNOWN_ENDED']);
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const clone = value => JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values)];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}
function text(value, name, {nullable = false} = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty text`);
  return value;
}
function allowed(value, keys, name) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name}.${key} is not a business time field`);
}
function calendarValid(year, month = 1, day = 1) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function explicitOffset(value) {
  if (value === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value || '');
  if (!match || +match[2] > 14 || +match[3] > 59 || (+match[2] === 14 && +match[3] !== 0)) return null;
  return (match[1] === '+' ? 1 : -1) * (+match[2] * 60 + +match[3]) * 60_000;
}
function utc(year, month, day) {
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}
function isoParts(value) {
  if (!INSTANT.test(value)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || !calendarValid(+match[1], +match[2], +match[3]) || +match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) return null;
  if (match[8] && explicitOffset(match[8]) === null) return null;
  return match;
}

/** Returns comparable possible boundary bounds without changing the preserved source value. */
function bounds(endpoint) {
  if (endpoint.kind !== 'KNOWN') return null;
  const {value, precision, timezone} = endpoint;
  if (['MILLISECOND', 'SECOND', 'MINUTE'].includes(precision)) {
    const parts = isoParts(value);
    if (!parts || !parts[8] || (precision !== 'MINUTE' && !parts[6])) return null;
    // A separate offset cannot contradict the offset already carried by the original value.
    if (timezone && explicitOffset(timezone) !== null && explicitOffset(timezone) !== explicitOffset(parts[8])) return null;
    const lower = Date.parse(value);
    if (!Number.isFinite(lower)) return null;
    return {lower, upper: precision === 'MINUTE' ? lower + 60_000 : lower, exact: precision !== 'MINUTE'};
  }
  const expression = precision === 'YEAR' ? /^(\d{4})$/ : precision === 'MONTH' ? /^(\d{4})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/;
  const parts = expression.exec(value);
  if (!parts || !calendarValid(+parts[1], +(parts[2] || 1), +(parts[3] || 1))) return null;
  const offset = explicitOffset(timezone);
  if (offset === null) return null;
  const year = +parts[1], month = +(parts[2] || 1), day = +(parts[3] || 1);
  const lower = utc(year, month, day) - offset;
  const upper = (precision === 'YEAR' ? utc(year + 1, 1, 1) : precision === 'MONTH' ? utc(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) : utc(year, month, day) + 86_400_000) - offset;
  return {lower, upper, exact:false};
}

function normalizeEndpoint(input, side, gaps) {
  const value = input === undefined || input === null ? {kind:'UNKNOWN'} : input;
  object(value, side);
  allowed(value, ['kind', 'value', 'precision', 'timezone', 'time_text', 'basis'], side);
  if (!ENDPOINT_KINDS.has(value.kind)) throw new TypeError(`${side}.kind is not supported`);
  if (side !== 'valid_to' && ['OPEN_AS_REPORTED', 'UNKNOWN_ENDED'].includes(value.kind)) throw new TypeError(`${value.kind} is only valid for valid_to`);
  const endpoint = {kind:value.kind};
  for (const key of ['time_text', 'basis', 'timezone']) if (value[key] !== undefined) endpoint[key] = text(value[key], `${side}.${key}`, {nullable:key === 'time_text'});
  if (value.kind !== 'KNOWN') {
    if (value.value !== undefined || value.precision !== undefined) throw new TypeError(`${side} unknown endpoint cannot carry a value or precision`);
    gaps.push(`${side}:${value.kind}`);
    return endpoint;
  }
  endpoint.value = text(value.value, `${side}.value`);
  if (!PRECISIONS.has(value.precision)) throw new TypeError(`${side}.precision is not supported`);
  endpoint.precision = value.precision;
  if (!bounds(endpoint)) gaps.push(`${side}:NOT_COMPARABLE`);
  if (['MINUTE', 'DAY', 'MONTH', 'YEAR'].includes(endpoint.precision)) gaps.push(`${side}:COARSE_PRECISION`);
  return endpoint;
}

/** Normalize explicit business time; no omitted date becomes TIMELESS or an open interval. */
export function normalizeValidTime(input = null) {
  if (input === null || input === undefined) return {kind:'UNRESOLVED', time_text:null, gaps:['TIME_NOT_PROVIDED']};
  object(input, 'valid_time');
  allowed(input, ['kind', 'time_text', 'basis', 'gaps', 'occurred_at', 'valid_from', 'valid_to'], 'valid_time');
  if (!TIME_KINDS.has(input.kind)) throw new TypeError('valid_time.kind is not supported');
  const result = {kind:input.kind, time_text:input.time_text === undefined ? null : text(input.time_text, 'valid_time.time_text', {nullable:true}), gaps:[]};
  if (input.basis !== undefined) result.basis = text(input.basis, 'valid_time.basis');
  if (input.gaps !== undefined) {
    if (!Array.isArray(input.gaps) || input.gaps.some(gap => typeof gap !== 'string' || !gap.trim())) throw new TypeError('valid_time.gaps must be a list of text');
    result.gaps.push(...input.gaps);
  }
  if (input.kind === 'INSTANT') {
    if (input.valid_from !== undefined || input.valid_to !== undefined) throw new TypeError('INSTANT cannot carry interval endpoints');
    result.occurred_at = normalizeEndpoint(input.occurred_at, 'occurred_at', result.gaps);
  } else if (input.kind === 'INTERVAL') {
    if (input.occurred_at !== undefined) throw new TypeError('INTERVAL cannot carry occurred_at');
    result.valid_from = normalizeEndpoint(input.valid_from, 'valid_from', result.gaps);
    result.valid_to = normalizeEndpoint(input.valid_to, 'valid_to', result.gaps);
    const start = bounds(result.valid_from), end = bounds(result.valid_to);
    if (start && end && start.lower >= end.upper) throw new TypeError('valid_time interval must have a possible positive duration');
  } else {
    if (input.occurred_at !== undefined || input.valid_from !== undefined || input.valid_to !== undefined) throw new TypeError(`${input.kind} cannot carry endpoints`);
    if (input.kind === 'TIMELESS') text(result.basis, 'TIMELESS.basis');
    else if (result.gaps.length === 0) result.gaps.push('TIME_UNRESOLVED');
  }
  result.gaps = unique(result.gaps);
  return result;
}

function exactQueryAt(at) {
  text(at, 'at');
  if (!OFFSET.test(at) || !isoParts(at)) throw new TypeError('at must be an ISO instant with an explicit timezone');
  const value = Date.parse(at);
  if (!Number.isFinite(value)) throw new TypeError('at must be a valid instant');
  return value;
}

/** AT matching only. It does not infer state continuation or support DURING/full-period claims. */
export function matchValidTime(validTime, {at} = {}) {
  const time = normalizeValidTime(validTime);
  const result = (status, reason) => ({status, reason, gaps:clone(time.gaps)});
  if (at === undefined || at === null) return result('ALL', 'No business time restriction was requested.');
  const point = exactQueryAt(at);
  if (time.kind === 'TIMELESS') return result('SUPPORTED', 'The record explicitly declares a time independent definition.');
  if (time.kind === 'UNRESOLVED') return result('UNDATED_CONTEXT', 'No resolved business time is available.');
  if (time.kind === 'INSTANT') {
    const event = bounds(time.occurred_at);
    if (!event) return result('UNDATED_CONTEXT', 'The event cannot be placed on a comparable timeline.');
    if (event.exact) return result(point === event.lower ? 'SUPPORTED' : 'OUTSIDE', 'An event is matched as a point, not an empty interval.');
    return result(point >= event.lower && point < event.upper ? 'POSSIBLE' : 'OUTSIDE', 'The reported event precision does not identify a specific instant.');
  }
  const start = bounds(time.valid_from), end = bounds(time.valid_to);
  if (!start && !end) return result('UNDATED_CONTEXT', 'Neither interval boundary is comparable.');
  if ((start && point < start.lower) || (end && point >= end.upper)) return result('OUTSIDE', 'The query is outside every compatible interval.');
  if (!start || !end) return result('POSSIBLE', 'An unknown or open boundary cannot establish validity at the query time.');
  const definitelyStarted = start.exact ? point >= start.lower : point >= start.upper;
  const definitelyNotEnded = point < end.lower;
  return result(definitelyStarted && definitelyNotEnded ? 'SUPPORTED' : 'POSSIBLE', 'Interval boundaries use [valid_from, valid_to); coarse boundaries retain uncertainty.');
}
