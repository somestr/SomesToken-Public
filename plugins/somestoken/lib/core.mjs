import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFastModeMetadata } from './fast-mode.mjs';
import { telemetryOutcomeLabel } from './telemetry-outcomes.mjs';

// v3 removes every persisted identity that was derived from a transcript path.
// State identities now derive solely from safe host lifecycle identifiers.
export const SCHEMA_VERSION = 3;
export const PARSER_VERSION = 3;
export const PONYTAIL_UNKNOWN_REASON = 'no supported cross-plugin signal';

const USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'cache_write_input_tokens',
];

const REQUIRED_USAGE_KEYS = ['input_tokens', 'output_tokens', 'total_tokens'];
const OPTIONAL_USAGE_KEYS = new Set(['cache_write_input_tokens']);

// Runtime metadata is public-facing and persisted. Accept only compact
// protocol-style identifiers, never free-form display text or identifiers.
const RUNTIME_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SENSITIVE_RUNTIME_VALUE = /(?:^|[-_])(sk|rk|ghp|github_pat|xox[baprs]|AIza)[-_]/i;
const OPAQUE_HOST_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PONYTAIL_MODES = new Set(['off', 'lite', 'full', 'ultra', 'review']);
const RECEIPT_METADATA_TIERS = new Set(['Fast', 'Fast→Standard', 'Standard']);
const RECEIPT_METADATA_MAX_PARTS = 4;
const RECEIPT_METADATA_MAX_SUBAGENTS = 128;
const RECEIPT_METADATA_MAX_LENGTH = 512;
export const METADATA_KEYS = Object.freeze(['model', 'reasoning_effort', 'codex_mode', 'permission_mode', 'agent_type', 'agent_role', 'service_tier', 'requested_service_tier']);
export const METADATA_STATUSES = new Set(['observed', 'partial', 'unknown']);
export const METADATA_CONFIDENCE = new Set(['high', 'medium', 'low']);
export const METADATA_SOURCES = new Set(['hook', 'turn_context', 'hook+turn_context']);

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeRuntimeValue(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && RUNTIME_VALUE.test(normalized) && !SENSITIVE_RUNTIME_VALUE.test(normalized) ? normalized : undefined;
}

function safeMetadataModelEffort(value) {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator !== value.lastIndexOf('/') || separator === value.length - 1) return false;
  return [value.slice(0, separator),value.slice(separator + 1)].every(part=>RUNTIME_VALUE.test(part)&&!SENSITIVE_RUNTIME_VALUE.test(part));
}

function safeSubagentMetadataGroups(value) {
  const groups = typeof value === 'string' ? value.split(',') : [];
  if (!groups.length || groups.length > RECEIPT_METADATA_MAX_SUBAGENTS) return false;
  return groups.every((group) => {
    const separator = group.lastIndexOf('×');
    if (separator <= 0 || separator === group.length - 1) return false;
    const count = Number(group.slice(separator + 1));
    return safeMetadataModelEffort(group.slice(0, separator))
      && Number.isSafeInteger(count)
      && count > 0
      && count <= RECEIPT_METADATA_MAX_SUBAGENTS;
  });
}

/**
 * Receipt summaries are presentation-only, but may cross the public bridge.
 * Keep their grammar closed over metadata that SomesToken itself can produce;
 * free-form host or user text must never become a display field.
 */
export function safeReceiptMetadataSummary(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > RECEIPT_METADATA_MAX_LENGTH) return undefined;
  const parts = normalized.split(' · ');
  if (parts.length > RECEIPT_METADATA_MAX_PARTS) return undefined;
  let index = 0;
  let sawContent = false;
  let sawMain = false;
  if (parts[index]?.startsWith('main ')) {
    if (!safeMetadataModelEffort(parts[index].slice('main '.length))) return undefined;
    sawContent = true;
    sawMain = true;
    index += 1;
  }
  if (RECEIPT_METADATA_TIERS.has(parts[index])) {
    if (!sawMain) return undefined;
    sawContent = true;
    index += 1;
  }
  if (parts[index]?.startsWith('sub ')) {
    if (!safeSubagentMetadataGroups(parts[index].slice('sub '.length))) return undefined;
    sawContent = true;
    index += 1;
  }
  if (parts[index]?.startsWith('Ponytail ')) {
    if (!PONYTAIL_MODES.has(parts[index].slice('Ponytail '.length))) return undefined;
    sawContent = true;
    index += 1;
  }
  return sawContent && index === parts.length ? normalized : undefined;
}

export function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const key of METADATA_KEYS) {
    if (key === 'service_tier' || key === 'requested_service_tier') continue;
    const safe = safeRuntimeValue(value[key]);
    if (safe !== undefined) output[key] = safe;
  }
  const fast = normalizeFastModeMetadata(value);
  if (fast?.service_tier) output.service_tier = fast.service_tier;
  if (fast?.requested_service_tier) output.requested_service_tier = fast.requested_service_tier;
  const source = METADATA_SOURCES.has(value.source) ? value.source : undefined;
  if (source) output.source = source;
  if (!METADATA_KEYS.some((key) => Object.hasOwn(output, key))) return null;
  const complete = ['model', 'reasoning_effort', 'codex_mode', 'permission_mode'].every((key) => output[key]);
  return {
    ...output,
    status: complete ? 'observed' : 'partial',
    confidence: complete ? 'high' : 'medium',
  };
}

function metadataFromObject(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = {};
  const nested = [value.agent_output, value.agent]
    .find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? {};
  for (const [output, keys] of Object.entries({
    model: ['model', 'resolved_model', 'resolvedModel'],
    reasoning_effort: ['reasoning_effort', 'effort'],
    codex_mode: ['codex_mode', 'execution_mode', 'collaboration_mode'],
    permission_mode: ['permission_mode'],
    agent_type: ['agent_type'],
    // Names and nicknames can carry task or user content. Only the
    // structured role field is eligible for the bounded metadata allowlist.
    agent_role: ['agent_role'],
    service_tier: ['service_tier', 'serviceTier', 'effective_service_tier', 'effectiveServiceTier'],
    requested_service_tier: ['requested_service_tier', 'requestedServiceTier'],
  })) {
    for (const key of keys) {
      const safe = safeRuntimeValue(value[key] ?? nested[key]);
      if (safe !== undefined) {
        metadata[output] = safe;
        break;
      }
    }
  }
  if (!Object.keys(metadata).length) return null;
  return sanitizeMetadata({ ...metadata, source });
}

function mergeSource(...values) {
  return [...new Set(values.filter(Boolean).flatMap((value) => String(value).split('+')))].sort().join('+') || undefined;
}

export function mergeRuntimeMetadata(...values) {
  const entries = values.map((value) => sanitizeMetadata(value)).filter(Boolean);
  if (!entries.length) return { status: 'unknown', confidence: 'low' };
  const metadata = Object.assign({}, ...entries);
  const complete = ['model', 'reasoning_effort', 'codex_mode', 'permission_mode'].every((key) => metadata[key]);
  return {
    ...metadata,
    source: mergeSource(...entries.map((entry) => entry.source)),
    status: complete ? 'observed' : 'partial',
    confidence: complete ? 'high' : 'medium',
  };
}

function contextObject(event) {
  if (!event || typeof event !== 'object') return [];
  const values = [];
  if (event.type === 'event_msg' && event.payload?.type === 'turn_context') {
    values.push(event.payload.info, event.payload);
  }
  if (event.type === 'turn_context') values.push(event.payload, event.info, event);
  if (event.payload?.type === 'turn_context') values.push(event.payload.info, event.payload);
  return values;
}

export function parseRuntimeMetadata(event) {
  for (const value of contextObject(event)) {
    const metadata = metadataFromObject(value, 'turn_context');
    if (metadata) return metadata;
  }
  return null;
}

function markerFromString(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = value.match(/(?:^|\n)PONYTAIL:(OFF|LITE|FULL|ULTRA|REVIEW)(?:$|\r?\n)/i);
  return match ? match[1].toLowerCase() : null;
}

function trustedMarkerStrings(event) {
  if (!event || typeof event !== 'object') return [];
  // ponytail: only host/system fields may confirm a marker. Never inspect
  // prompt fields: they are content-bearing and SomesToken is report-only.
  const eventTypes = [event.type, event.payload?.type].filter((value) => typeof value === 'string').map((value) => value.toLowerCase());
  if (eventTypes.some((value) => value === 'user_prompt' || value === 'user_message' || value === 'user_prompt_submit')) return [];
  return [
    event.systemMessage,
    event.payload?.systemMessage,
    event.payload?.hookSpecificOutput?.systemMessage,
    event.hookSpecificOutput?.systemMessage,
  ];
}

function ponytailMarkerReader() {
  let mode;
  let coverageCount = 0;
  return {
    accept(event) {
      for (const value of trustedMarkerStrings(event)) {
        const marker = markerFromString(value);
        if (marker) {
          mode = marker;
          coverageCount += 1;
        }
      }
    },
    finish() {
      const status = mode ? (mode === 'off' ? 'off-confirmed' : 'confirmed-marker') : 'unknown';
      return {
        ...(mode ? { mode } : {}),
        status,
        ...(status === 'unknown' ? { reason: PONYTAIL_UNKNOWN_REASON } : {}),
        coverage_count: coverageCount,
      };
    },
  };
}

export function parsePonytailMarkers(text) {
  const markers = ponytailMarkerReader();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    markers.accept(event);
  }
  return markers.finish();
}

/** Validate canonical observed counters again at persisted/analysis boundaries. */
export function isValidUsage(value, { reasoningObserved = true } = {}) {
  return value?.consistent === true
    && USAGE_KEYS.every(key => key === 'cache_write_input_tokens' && value[key] == null
      || key === 'reasoning_output_tokens' && !reasoningObserved && value[key] == null
      || integer(value[key]) !== null)
    && value.input_tokens <= Number.MAX_SAFE_INTEGER - value.output_tokens
    && value.total_tokens === value.input_tokens + value.output_tokens
    && value.cached_input_tokens <= value.input_tokens
    && (!reasoningObserved || value.reasoning_output_tokens <= value.output_tokens);
}

function usageFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {};
  for (const key of USAGE_KEYS) {
    if (OPTIONAL_USAGE_KEYS.has(key)) {
      usage[key] = value[key] === undefined || value[key] === null ? null : integer(value[key]);
      continue;
    }
    const parsed = integer(value[key] ?? 0);
    if (parsed === null) return null;
    usage[key] = parsed;
  }
  if (REQUIRED_USAGE_KEYS.some((key) => value[key] === undefined || value[key] === null)) return null;
  usage.consistent = usage.input_tokens <= Number.MAX_SAFE_INTEGER - usage.output_tokens
    && usage.total_tokens === usage.input_tokens + usage.output_tokens
    && usage.cached_input_tokens <= usage.input_tokens
    && usage.reasoning_output_tokens <= usage.output_tokens;
  return usage;
}

function claudeUsageFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const uncachedInput = integer(value.input_tokens);
  const outputTokens = integer(value.output_tokens);
  const cachedInput = integer(value.cache_read_input_tokens ?? 0);
  const rawCacheWrite = value.cache_creation_input_tokens ?? value.cache_write_input_tokens;
  const cacheWrite = rawCacheWrite === undefined || rawCacheWrite === null ? null : integer(rawCacheWrite);
  const reasoningOutput = integer(value.reasoning_output_tokens ?? value.reasoning_tokens ?? 0);
  if ([uncachedInput, outputTokens, cachedInput, reasoningOutput].some((entry) => entry === null)) return null;
  // Claude's cache-write counter is a separate billable component in some
  // provider contracts; it is observed but is not folded into total_tokens
  // without an active versioned pricing contract. Cache-read input is the
  // only confirmed subset included in the aggregate input counter here.
  if (uncachedInput > Number.MAX_SAFE_INTEGER - cachedInput) return null;
  const inputTokens = uncachedInput + cachedInput;
  if (inputTokens > Number.MAX_SAFE_INTEGER - outputTokens) return null;
  const totalTokens = inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInput,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutput,
    total_tokens: totalTokens,
    cache_write_input_tokens: cacheWrite,
    consistent: cachedInput <= inputTokens,
  };
}

function claudeUsageFromEvent(event) {
  return event?.type === 'assistant' ? claudeUsageFrom(event.message?.usage) : null;
}

function claudeMetadataFromEvent(event) {
  if (event?.type !== 'assistant') return null;
  return metadataFromObject({ model: event.message?.model }, 'turn_context');
}

function tokenUsageFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [];
  if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
    candidates.push(event.payload.info?.total_token_usage);
    candidates.push(event.payload.total_token_usage);
  }
  if (event.type === 'token_count') {
    candidates.push(event.info?.total_token_usage, event.total_token_usage, event.usage);
  }
  if (event.payload?.type === 'token_count') {
    candidates.push(event.payload.info?.total_token_usage, event.payload.total_token_usage);
  }
  for (const candidate of candidates) {
    const usage = usageFrom(candidate);
    if (usage) return usage;
  }
  return null;
}

// Structured host records are a separate accounting authority. Never add a
// legacy token_count mirror to these per-response counters.
// `state` is a snapshot() of a reader that parsed a file's prefix, so a capture
// in a later process can continue it. Its identifiers are already hashed.
export function createCodexLedgerReader({legacy = false, state = null} = {}) {
  if (state) legacy = state.legacy === true;
  const groups = new Map(state?.groups);
  const responses = new Map(state?.responses);
  const contexts = new Map(state?.contexts);
  const contextRoots = new Map(state?.contextRoots);
  const completed = new Map(state?.completed);
  const legacyGroups = new Map(state?.legacyGroups), legacyResponses = new Map(state?.legacyResponses), legacyPrevious = new Map(state?.legacyPrevious);
  const structuredTurns = new Set(state?.structuredTurns), invalidStructuredThreads = new Set(state?.invalidStructuredThreads), legacyGaps = new Set(state?.legacyGaps);
  let present = state?.present === true, invalid = state?.invalid === true, latest = state?.latest ?? null, metadata = state?.metadata ?? null, sourceThread = state?.sourceThread ?? null;
  let sourceSession = state?.sourceSession ?? null, legacyTurn = state?.legacyTurn ?? null;
  // Codex records the thread's requested tier in thread_settings_applied, before
  // each turn's turn_context. It is a request; the tier a response ran at stays unknown.
  let threadTier = state?.threadTier ?? null;
  const contextIds=new Map();
  const id = (v, kind) => {
    if(kind==='response'||!safeOpaqueHostIdentifier(v))return hashOpaqueHostIdentifier(v,`ledger:${kind}`);
    const key=kind+':'+v;
    if(contextIds.has(key))return contextIds.get(key);
    const value=hashOpaqueHostIdentifier(v,`ledger:${kind}`);
    if(contextIds.size<8192)contextIds.set(key,value);
    return value;
  };
  const validUsage = (value) => {
    const u = usageFrom(value);
    return u?.consistent && USAGE_KEYS.every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)
      && u.reasoning_output_tokens <= u.output_tokens ? u : null;
  };
  const equalUsage = (a,b) => a && b && USAGE_KEYS.every(k=>a[k]===b[k]);
  const legacyUsage = value => {
    const u=usageFrom(value);
    return u?.consistent && USAGE_KEYS.every(k=>k==='cache_write_input_tokens'&&u[k]===null||Number.isSafeInteger(u[k])&&u[k]>=0)
      && u.reasoning_output_tokens<=u.output_tokens ? u : null;
  };
  function acceptLegacy(event) {
    const info=event.payload?.info, total=legacyUsage(info?.total_token_usage), last=legacyUsage(info?.last_token_usage);
    if(!sourceThread||!legacyTurn){legacyGaps.add('legacy_context_unavailable');return;}
    if(!total||!last||!Number.isSafeInteger(Date.parse(event.timestamp))||Date.parse(event.timestamp)<=0){legacyGaps.add('invalid_legacy_usage');return;}
    if(USAGE_KEYS.some(k=>last[k]!==null&&total[k]!==null&&last[k]>total[k])){legacyGaps.add('invalid_legacy_usage');return;}
    const previous=legacyPrevious.get(sourceThread);
    if(equalUsage(previous?.total,total)){
      if(!equalUsage(previous.last,last)){legacyGaps.add('invalid_legacy_usage');const g=legacyGroups.get(`${sourceThread}:${legacyTurn}`);if(g)g.invalid=true;}
      return;
    }
    const delta=deltaUsage(previous?.total??null,total);
    if(!equalUsage(delta,last))legacyGaps.add('legacy_counter_discontinuity');
    legacyPrevious.set(sourceThread,{total,last});
    // Only the explicitly observed last-request counter is imported. A reset,
    // missing prefix or skipped response cannot turn the cumulative total into
    // an invented request attributed to the current model.
    const key=`${sourceThread}:${legacyTurn}`;
    const response=crypto.createHash('sha256').update(JSON.stringify(['legacy',sourceThread,legacyTurn,Date.parse(event.timestamp),total])).digest('hex').slice(0,20);
    const signature=JSON.stringify(last), existing=legacyResponses.get(response);
    if(existing){if(existing!==signature){legacyGaps.add('invalid_legacy_usage');const g=legacyGroups.get(key);if(g)g.invalid=true;}return;}
    if(legacyResponses.size>=100000){legacyGaps.add('legacy_response_bound');return;}
    legacyResponses.set(response,signature);
    const g=legacyGroups.get(key)??{session:sourceSession??sourceThread,thread:sourceThread,turn:legacyTurn,root:contextRoots.get(legacyTurn)??null,records:[],legacy:true};
    const context=contexts.get(legacyTurn);
    g.records.push({response_key:response,usage:last,model:safeModel(context?.model)??'unknown',reasoning_effort:context?.reasoning_effort??'unknown',service_tier:context?.service_tier??'unknown',requested_service_tier:context?.requested_service_tier??'unknown',observed_at:Date.parse(event.timestamp),record_basis:'legacy_counter_event'});
    g.total=sumUsage([g.total,last]);g.at=Date.parse(event.timestamp);legacyGroups.set(key,g);
  }
  return {
    rejectStructuredSource() {if(sourceThread)invalidStructuredThreads.add(sourceThread);},
    // The contextIds memo is keyed by raw identifiers; it is left out and rebuilt.
    snapshot() {
      return {legacy, groups:[...groups], responses:[...responses], contexts:[...contexts], contextRoots:[...contextRoots], completed:[...completed],
        legacyGroups:[...legacyGroups], legacyResponses:[...legacyResponses], legacyPrevious:[...legacyPrevious],
        structuredTurns:[...structuredTurns], invalidStructuredThreads:[...invalidStructuredThreads], legacyGaps:[...legacyGaps],
        present, invalid, latest, metadata, sourceThread, sourceSession, legacyTurn, threadTier};
    },
    resetContext(threadId=null,sessionId=null) { contexts.clear();contextRoots.clear(); metadata=null; threadTier=null; sourceThread=id(threadId, 'thread');sourceSession=id(sessionId,'session');legacyTurn=null;legacyPrevious.delete(sourceThread); },
    accept(event) {
      const p = event?.payload;
      if (event?.type === 'session_meta') { contexts.clear();contextRoots.clear(); metadata=null; threadTier=null; sourceThread=id(p?.id, 'thread');sourceSession=id(p?.session_id,'session');legacyTurn=null; }
      if (event?.type === 'event_msg' && p?.type === 'thread_settings_applied')
        threadTier = normalizeFastModeMetadata({ requested_service_tier: p.thread_settings?.service_tier })?.requested_service_tier ?? null;
      if (event?.type === 'turn_context') {
        metadata = parseRuntimeMetadata(event);
        if (threadTier && !metadata?.requested_service_tier) metadata = { ...metadata, requested_service_tier: threadTier };
        legacyTurn=id(p?.turn_id,'turn');
        if(legacyTurn)contextRoots.set(legacyTurn,id(p?.root_turn_id,'turn'));
        if (id(p?.turn_id, 'turn')) contexts.set(id(p.turn_id, 'turn'), metadata);
      }
      if (event?.type === 'event_msg' && p?.type === 'task_complete') {
        const turn = id(p.turn_id, 'turn');
        if (turn) completed.set(`${sourceThread ?? ''}:${turn}`, { thread:sourceThread, turn, at: Date.parse(event.timestamp) || 0,
          duration_ms: Number.isSafeInteger(p.duration_ms) && p.duration_ms >= 0 ? p.duration_ms : null });
      }
      if(legacy && event?.type==='event_msg' && p?.type==='token_count')acceptLegacy(event);
      if (event?.type !== 'token_usage_record') return;
      present = true;
      const session = id(p?.session_id, 'session'), thread = id(p?.thread_id, 'thread');
      const turn = id(p?.turn_id, 'turn'), root = id(p?.root_turn_id, 'turn'), response = id(p?.response_id, 'response');
      if(thread&&turn)structuredTurns.add(`${thread}:${turn}`);
      else if(sourceThread)invalidStructuredThreads.add(sourceThread);
      const usage = validUsage(p?.usage), total = validUsage(p?.turn_token_usage), threadTotal = validUsage(p?.thread_token_usage);
      if (!session || !thread || !turn || !root || !response || !usage || !total || !threadTotal) { invalid = true; return; }
      sourceThread=thread;
      const key = `${thread}:${turn}`;
      let g = groups.get(key);
      if (!g) { g = { session, thread, turn, root, records: [], invalid: false }; groups.set(key, g); }
      if (g.session !== session || g.root !== root) g.invalid = true;
      const signature = crypto.createHash('sha256').update(JSON.stringify({ session, thread, turn, root, usage, total, threadTotal })).digest('hex');
      if (responses.has(response)) {
        const old = responses.get(response);
        if (old.signature !== signature) { g.invalid = true; if (groups.has(old.key)) groups.get(old.key).invalid = true; invalid = true; }
        return;
      }
      if (responses.size >= 100000) { invalid=true; g.invalid=true; return; }
      responses.set(response, { signature, key });
      const context = contexts.get(turn);
      g.records.push({ response_key:response, usage, model: safeModel(context?.model) ?? 'unknown',
        reasoning_effort: context?.reasoning_effort ?? 'unknown',
        service_tier: context?.service_tier ?? 'unknown',
        requested_service_tier: context?.requested_service_tier ?? 'unknown',
        observed_at: Date.parse(event.timestamp) || 0 });
      g.total = total;
      g.at = Date.parse(event.timestamp) || 0;
      latest = { usage: threadTotal, thread };
    },
    finish({details=true}={}) {
      const retainedLegacy=[...legacyGroups.entries()].filter(([key,g])=>!structuredTurns.has(key)&&!invalidStructuredThreads.has(g.thread)).map(([,g])=>g);
      const turns = [...groups.values(),...retainedLegacy].map(g => {
        const completion=completed.get(`${g.thread}:${g.turn}`) ?? completed.get(`:${g.turn}`);
        const sum = sumUsage(g.records.map(r => r.usage));
        const reconciled = Boolean(g.total) && sum.consistent && USAGE_KEYS.every(k => sum[k] === g.total[k]);
        const models = new Map();
        if(details)for (const r of g.records) {
          const key = `${r.model}:${r.reasoning_effort}`;
          const m = models.get(key) ?? { model: r.model, reasoning_effort: r.reasoning_effort, usage: [] };
          m.usage.push(r.usage); models.set(key,m);
        }
        return { session:g.session, thread:g.thread, turn:g.turn, root:g.root,
          status:g.invalid ? 'unavailable' : g.legacy ? 'partial' : reconciled ? 'exact' : 'partial',
          record_basis:g.legacy?'legacy_counter_event':'structured_response',
          usage:g.invalid ? null : g.total, completed:Boolean(completion),
          created_at:completion?.at ?? g.at ?? 0, duration_ms:completion?.duration_ms ?? null,
          ...(details?{models:[...models.values()].map(m=>({...m,usage:sumUsage(m.usage)})),
            timeline:g.records.map(({response_key,...r},index)=>({...r,response:index+1}))}:{}),
          response_records:g.records,
          response_count:g.records.length };
      });
      const threads = new Set(turns.map(t=>t.thread));
      return { present, invalid, turns, structured_turns:[...structuredTurns],invalid_structured_threads:[...invalidStructuredThreads],coverage_gaps:retainedLegacy.length?[...legacyGaps,'legacy_counter_observations',...(retainedLegacy.some(g=>!g.root)?['legacy_root_unavailable']:[])]:[...legacyGaps].filter(g=>g==='legacy_context_unavailable'||g==='invalid_legacy_usage'),completions:[...completed.values()].filter(c=>c.thread), latest: !invalid && threads.size === 1 ? latest : null };
    },
  };
}

export function parseCodexLedger(text) {
  const reader = createCodexLedgerReader();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    try { reader.accept(JSON.parse(line)); } catch { /* non-record lines cannot supply usage */ }
  }
  return reader.finish();
}

/** Parse only numeric token snapshots. Event content is intentionally discarded. */
export function parseTokenSnapshots(text) {
  const snapshots = [];
  const claudeSnapshots = [];
  const codexSnapshots = [];
  let malformed = 0;
  let unknown = 0;
  let compactions = 0;
  let metadata = null;
  const ledgerReader = createCodexLedgerReader(), markers = ponytailMarkerReader();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    // Each line is parsed once; the Codex ledger and Ponytail markers read the
    // same event (a Claude Stop used to parse the whole transcript three times).
    try { ledgerReader.accept(event); } catch { /* as parseCodexLedger: the record supplies no usage */ }
    markers.accept(event);
    if (event?.type === 'context_compacted' || event?.type === 'context_compaction' || event?.payload?.type === 'context_compacted') {
      compactions += 1;
      continue;
    }
    metadata = claudeMetadataFromEvent(event) || parseRuntimeMetadata(event) || metadata;
    const claudeUsage = claudeUsageFromEvent(event);
    const usage = tokenUsageFromEvent(event);
    if (claudeUsage) {
      const snapshot = { usage: claudeUsage };
      snapshots.push(snapshot);
      claudeSnapshots.push(snapshot);
    } else if (usage) {
      const snapshot = { usage };
      snapshots.push(snapshot);
      codexSnapshots.push(snapshot);
    }
    if (!claudeUsage && !usage) {
      if (event?.type === 'assistant' && event.message?.usage !== undefined) malformed += 1;
      else if (event?.type === 'event_msg' && event?.payload?.type === 'token_count') malformed += 1;
      else if (event?.type === 'token_count' || event?.payload?.type === 'token_count') malformed += 1;
      else unknown += 1;
    }
  }
  const ledger = ledgerReader.finish(), ponytail = markers.finish();
  if (ledger.present && !claudeSnapshots.length) {
    const latest = ledger.latest ? { usage: ledger.latest.usage } : null;
    return { parser_version: PARSER_VERSION, runtime:'codex', supported:Boolean(latest),
      snapshots:latest ? [latest] : [], latest, metadata, ponytail,
      malformed, unknown, compactions, usage_source:'codex_structured_ledger', ledger };
  }
  const runtime = claudeSnapshots.length && !codexSnapshots.length ? 'claude' : 'codex';
  const latest = runtime === 'claude'
    ? { usage: sumUsage(claudeSnapshots.map((snapshot) => snapshot.usage)) }
    : codexSnapshots.at(-1) ?? null;
  return {
    parser_version: PARSER_VERSION,
    runtime,
    supported: snapshots.length > 0,
    snapshots,
    latest,
    metadata,
    ponytail,
    malformed,
    unknown,
    compactions,
  };
}

export function deltaUsage(previous, current) {
  if (!current) return null;
  const next = usageFrom(current);
  const prior = previous ? usageFrom(previous) : { ...USAGE_KEYS.reduce((out, key) => {
    out[key] = 0;
    return out;
  }, {}), consistent: true };
  if (!next || !prior) return null;
  if (USAGE_KEYS.some((key) => !OPTIONAL_USAGE_KEYS.has(key) && next[key] < prior[key])) return null;
  const delta = {};
  for (const key of USAGE_KEYS) {
    delta[key] = OPTIONAL_USAGE_KEYS.has(key)
      && (next[key] === null || prior[key] === null || next[key] < prior[key])
      ? null
      : next[key] - prior[key];
  }
  delta.consistent = next.consistent && prior.consistent;
  return delta;
}

export function classifyReceipt({ main, subagents = [], ambiguous = false }) {
  if (!main?.valid) return 'unavailable';
  if (ambiguous || subagents.some((entry) => !entry.valid)) return 'partial';
  return 'exact';
}

export function compact(value) {
  const amount = Math.max(0, Number.isFinite(value) ? value : 0);
  if (amount < 1000) return String(Math.round(amount));
  const units = [['K', 1e3], ['M', 1e6], ['B', 1e9]];
  let unit = units[0];
  for (const candidate of units) {
    if (amount >= candidate[1]) unit = candidate;
  }
  const rounded = Math.round((amount / unit[1]) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${unit[0]}`;
}

const HUMAN_LABELS = Object.freeze({
  insufficient_evidence:'not enough evidence',insufficient_data:'not enough data',
  unresolved_task_ancestry:'subagent parent could not be traced',
  host_plugin_data_unavailable:'host plugin data is unavailable',
  public_snapshot_unavailable:'no public snapshot is available',
  last_observed_at_desc:'most recently active first',
  clock_anomaly:'system clock needs checking',
});
export function humanLabel(value) {
  if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(value)||isSensitiveRuntimeValue(value))return 'unavailable';
  return Object.hasOwn(HUMAN_LABELS,value)?HUMAN_LABELS[value]:value.replaceAll('_',' ');
}

export function formatReceipt(receipt) {
  if (receipt?.status === 'unavailable' && receipt?.telemetry_reconciliation?.state === 'pending_post_turn') {
    const message = receipt.reason === 'stop_failure'
      ? 'SomesToken · usage pending · stop failure'
      : 'SomesToken · usage pending';
    const label = telemetryOutcomeLabel(receipt?.telemetry_reconciliation?.outcome);
    return `${label ? `${message} · ${label}` : message} · Next: wait for the next host hook, then check diagnostics.`;
  }
  if (!receipt || receipt.status === 'unavailable') {
    const message = receipt?.reason === 'stop_failure'
      ? 'SomesToken · usage unavailable · stop failure'
      : 'SomesToken · usage unavailable';
    const label = telemetryOutcomeLabel(receipt?.telemetry_reconciliation?.outcome);
    return `${label ? `${message} · ${label}` : message} · Next: check SomesToken diagnostics.`;
  }
  if (!Number.isSafeInteger(receipt.total_tokens) || receipt.total_tokens < 0) {
    return 'SomesToken · usage unavailable · Next: check SomesToken diagnostics.';
  }
  const prefix = receipt.status === 'partial' ? '≥' : '';
  const total = `${prefix}${compact(receipt.total_tokens)}`;
  const agentCount = Math.max(0, receipt.agents ?? 1);
  const agents = `${agentCount} ${agentCount===1?'agent':'agents'}`;
  const unavailable = receipt.unavailable_sources ?? receipt.unavailable ?? 0;
  const inputTokens = Number.isSafeInteger(receipt.input_tokens) && receipt.input_tokens >= 0 ? receipt.input_tokens : null;
  const cacheHitTokens = Number.isSafeInteger(receipt.cached_input_tokens) && receipt.cached_input_tokens >= 0
    ? receipt.cached_input_tokens : null;
  const outputTokens = Number.isSafeInteger(receipt.output_tokens) && receipt.output_tokens >= 0 ? receipt.output_tokens : null;
  const reasoningOutputTokens = Number.isSafeInteger(receipt.reasoning_output_tokens) && receipt.reasoning_output_tokens >= 0
    ? receipt.reasoning_output_tokens : null;
  const cacheWriteTokens = Number.isSafeInteger(receipt.cache_write_input_tokens) && receipt.cache_write_input_tokens >= 0
    ? receipt.cache_write_input_tokens : null;
  const cacheMissTokens = (inputTokens !== null && cacheHitTokens !== null)
    ? Math.max(0, inputTokens - cacheHitTokens)
    : null;
  const parts = [`SomesToken · ${total} total tokens`, agents, receipt.status];
  if (inputTokens !== null) parts.push(`input ${inputTokens} tokens`);
  if (cacheHitTokens !== null) parts.push(`cache hit ${cacheHitTokens} tokens`);
  if (cacheMissTokens !== null) parts.push(`cache miss ${cacheMissTokens} tokens`);
  if (outputTokens !== null) parts.push(`output ${outputTokens} tokens`);
  if (reasoningOutputTokens !== null) parts.push(`reasoning output ${reasoningOutputTokens} tokens`);
  if (cacheWriteTokens !== null) parts.push(`cache write ${cacheWriteTokens} tokens`);
  if (receipt.status === 'partial' && unavailable > 0) parts.push(`${unavailable} source unavailable`);
  const metadataSummary = safeReceiptMetadataSummary(receipt.metadata_summary);
  if (metadataSummary) parts.push(metadataSummary);
  // Receipt-level savings never carry a causal counter boundary. Legacy or
  // caller-supplied statuses therefore remain explicitly unmeasured rather
  // than formatting an estimated, measured, or regression claim.
  if (receipt.savings && typeof receipt.savings === 'object') parts.push('save unmeasured');
  if(receipt.status==='partial')parts.push('Next: review source coverage in the tasks view.');
  return parts.join(' · ');
}

export function hashId(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 20);
}

/**
 * Host lifecycle IDs may be hashed for bounded state correlation. Paths,
 * arbitrary text, and secret-shaped values are deliberately not identifiers.
 */
export function safeOpaqueHostIdentifier(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!OPAQUE_HOST_IDENTIFIER.test(normalized)) return undefined;
  if (normalized.includes('..') || SENSITIVE_RUNTIME_VALUE.test(normalized)) return undefined;
  return normalized;
}

/**
 * Hash of a module's source and of every module it imports by a relative
 * path, followed recursively. Saved parse results stay reusable while none of
 * that code changes, whatever the package version says. Only static
 * `import`/`export ... from` specifiers are followed; an unreadable file
 * contributes its error code.
 */
export function moduleRevision(url) {
  const start = fileURLToPath(url), root = path.dirname(start), texts = new Map(), todo = [start];
  while (todo.length) {
    const file = todo.pop();
    if (texts.has(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { text = `\0${error.code}`; }
    texts.set(file, text);
    for (const [, spec] of text.matchAll(/\b(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g)) todo.push(path.resolve(path.dirname(file), spec));
  }
  const hash = crypto.createHash('sha256');
  for (const file of [...texts.keys()].sort()) hash.update(`${path.relative(root, file)}\0${texts.get(file)}\0`);
  return hash.digest('hex');
}

export function hashOpaqueHostIdentifier(value, namespace = 'host') {
  const safe = safeOpaqueHostIdentifier(value);
  return safe ? hashId(`${namespace}:${safe}`) : undefined;
}

// Rotate bridge matching references on publication. Neither the host ID nor
// the stable internal session hash belongs in a public report or snapshot.
export function createReceiptTaskBinding(session) {
  if (typeof session !== 'string' || !/^[a-f0-9]{20}$/.test(session)) return undefined;
  const nonce = crypto.randomBytes(16).toString('hex');
  return { nonce, ref: hashId(`receipt-task:${nonce}:${session}`) };
}

export function normalizeReceiptTaskBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)
    || typeof value.ref !== 'string' || !/^[a-f0-9]{20}$/.test(value.ref)) return undefined;
  return { nonce: value.nonce, ref: value.ref };
}

export function receiptMatchesTask(receipt, session) {
  if (typeof session !== 'string' || !/^[a-f0-9]{20}$/.test(session)) return false;
  const binding = normalizeReceiptTaskBinding(receipt?.task_binding);
  return binding ? binding.ref === hashId(`receipt-task:${binding.nonce}:${session}`)
    : receipt?.session === session;
}

export function safeModel(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^[a-zA-Z0-9._:-]{1,80}$/);
  return match && !SENSITIVE_RUNTIME_VALUE.test(value) ? value : undefined;
}

export function sumUsage(entries) {
  const total = USAGE_KEYS.reduce((out, key) => {
    out[key] = 0;
    return out;
  }, {});
  const usable = entries.filter(Boolean);
  const cacheWriteKnown = usable.every((usage) => Number.isSafeInteger(usage?.cache_write_input_tokens)
    && usage.cache_write_input_tokens >= 0);
  let saturated = false;
  let invalid = false;
  for (const usage of usable) {
    if (!usage) continue;
    for (const key of USAGE_KEYS) {
      const value = usage[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) {
        invalid = true;
        continue;
      }
      if (total[key] > Number.MAX_SAFE_INTEGER - value) {
        total[key] = Number.MAX_SAFE_INTEGER;
        saturated = true;
      } else {
        total[key] += value;
      }
    }
  }
  if (usable.length && !cacheWriteKnown) total.cache_write_input_tokens = null;
  if (!usable.length) {
    total.consistent = true;
    return total;
  }
  const arithmetic = total.input_tokens <= Number.MAX_SAFE_INTEGER - total.output_tokens
    && total.total_tokens === total.input_tokens + total.output_tokens;
  const explicitFalse = usable.some((usage) => usage.consistent === false);
  const invalidComposition = usable.some((usage) => (usage.cached_input_tokens ?? 0) > (usage.input_tokens ?? 0)
    || (usage.reasoning_output_tokens ?? 0) > (usage.output_tokens ?? 0));
  const allKnown = usable.every((usage) => typeof usage.consistent === 'boolean');
  if (!arithmetic || explicitFalse || invalidComposition || saturated || invalid) total.consistent = false;
  else if (allKnown) total.consistent = true;
  return total;
}

export { USAGE_KEYS };

export function isSensitiveRuntimeValue(value) {
  return typeof value === 'string' && SENSITIVE_RUNTIME_VALUE.test(value);
}

export function isHashedIdentity(value) {
  return typeof value === 'string' && /^[a-f0-9]{20}$/.test(value);
}
