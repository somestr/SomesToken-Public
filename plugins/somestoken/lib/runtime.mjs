import { activePolicyHookContext, activeTaskPolicy } from './optimization/active-policy.mjs';
import { handoffHookResponse, rememberPluginData } from './handoff/hook.mjs';
import { recordLifecycleEvent, DEVELOPMENT_CONTEXT } from './optimization/lifecycle-checks.mjs';
import { captureTaskForecastProfile } from './task-profiles.mjs';
import { workspaceDirectory, readWorkspaceFile } from './workspace-usage.mjs';
import { configuredCodexLedgerRoot } from './codex-ledger.mjs';
import { configuredClaudeWorkspaceRoot } from './claude-workspace.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { releaseFileLock } from './monitor-lock.mjs';
import { SCHEMA_VERSION, classifyReceipt, deltaUsage, formatReceipt, humanLabel, hashId, hashOpaqueHostIdentifier, mergeRuntimeMetadata, parseTokenSnapshots, PONYTAIL_UNKNOWN_REASON, safeModel, safeReceiptMetadataSummary, sanitizeMetadata, safeOpaqueHostIdentifier, sumUsage, USAGE_KEYS } from './core.mjs';
import { advisorReport } from './reporting.mjs';
import { writePublicBridge } from './public-bridge.mjs';
import { normalizeCodexHook, normalizeCodexUsage } from './hosts/codex.mjs';
import { detectClaudeAuthMode, normalizeClaudeHook, normalizeClaudeUsage } from './hosts/claude-code.mjs';
import { calculateApiCost, calculateCodexCredits } from './usage/credits.mjs';
import { alertThresholds, localBudgetAlerts } from './usage/budgets.mjs';
import { buildPlanComparisons, planComparisonHealthKey } from './usage/comparison.mjs';
import { normalizeUsageLayers } from './usage/schema.mjs';
import { readSomesTokenConfig } from './usage/config.mjs';
import { normalizeQuotaSnapshot } from './usage/quota-snapshots.mjs';
import { detectEfficiency } from './efficiency/detector.mjs';
import { ERROR_CATEGORIES, normalizeEfficiencyResult } from './efficiency/schema.mjs';
import { createCapabilityRegistry, observeCapability, listCapabilities } from './efficiency/capabilities.mjs';
import { buildProvenance } from './efficiency/provenance.mjs';
import { createAdvisorState, recordSessionEvent, recordSanitizedSessionEvent, closeSession, trimAdvisorState, sessionKey, expireAdvisorState } from './efficiency/sessions.mjs';
import { createAcceptanceWindow, recordAcceptanceEvent, closeAcceptanceWindow, recoverAcceptanceWindows, readLiveAcceptanceContext } from './efficiency/acceptance.mjs';
import { readHotEvents, resetHotEvents } from './hot-events.mjs';
import { createOptimizationState, trimOptimizationState } from './optimization/schema.mjs';
import { recordGoalContinuation } from './optimization/goal-hygiene.mjs';
import { evaluateShadowPolicy } from './optimization/shadow-policy.mjs';
import { listExperiments } from './optimization/experiments.mjs';
import { findComparablePairs } from './optimization/pairing.mjs';
import { measureReduction } from './optimization/reductions.mjs';
import { WORKFLOW_ADVISOR_SCHEMA_VERSION, workflowAdvisorNotice, workflowContextForReceipt } from './workflow-advisor.mjs';
import { isTelemetryOutcome } from './telemetry-outcomes.mjs';
import { isHostOwnedAbsolutePath, unlinkOwnedFile } from './host-paths.mjs';
import { trimLimitRecoveryState, transitionLimitRecovery } from './limit-recovery/state.mjs';
import {
  MAX_STATE_BYTES,
  MAX_STATE_RETAINED_BYTES,
  MAX_STATE_STRING_BYTES,
  MAX_STATE_KEY_BYTES,
  MAX_STATE_DEPTH,
  MAX_STATE_ENTRIES,
  MAX_TURNS,
  MAX_AGENTS_PER_TURN,
  CLAUDE_FINAL_SNAPSHOT_TTL_MS,
  CLAUDE_ACCOUNTING_BASIS,
  MAX_USAGE_SNAPSHOTS,
  MAX_QUOTA_SNAPSHOTS,
  MAX_SESSION_TOTALS,
  MAX_EFFICIENCY_SCOPES,
  MAX_EFFICIENCY_EVENTS,
  MAX_EFFICIENCY_WARNINGS,
  RECOVERED_STATE,
  TELEMETRY_SOURCES,
  SUBAGENT_USAGE_SOURCES,
  incrementHealth,
  blankState,
  blankUsageState,
  blankEfficiencyState,
  persistedHotEventState,
  blankIdentityRebaseline,
  persistedUsage,
  boundedAlertMap,
  persistedPonytail,
  recoverState,
  tokenFields,
  loadState,
  saveState,
} from './runtime/state-store.mjs';
import {
  STATE_DIR_NAME,
  LOCK_FILE,
  HOT_CONTEXT_SCHEMA_VERSION,
  NON_DURABLE_EVENTS,
  PUBLIC_BRIDGE_ACTIVE_REFRESH_MS,
  CLAUDE_FINAL_SNAPSHOT_INVALIDATING_EVENTS,
  runtimeHost,
  safeLifecycleId,
  sourceIdentity,
  turnIdentity,
  scopeIdentity,
  fallbackScopeIdentity,
  lifecycleTurnIdentity,
  capabilityFields,
  hotContextFile,
  stateFingerprint,
  safeStateDirectory,
  ensureStateDirectory,
  tryFileLock,
  withLock,
  hookEnvironment,
  MAX_THREADS,
  MAX_HEALTH_COUNTER,
  timestamp,
  stateFile,
  deferHookEvent,
} from './runtime/hot-path.mjs';
export { recoverState };
export { STATE_DIR_NAME };

const MAX_TAIL_BYTES = 1024 * 1024;
const EFFICIENCY_WARNING_COOLDOWN_MS = 60_000;
// This is deliberately a fixed, content-free diagnostic vocabulary. It
// explains why a receipt has no usable token snapshot without retaining a
// path, parser error, host payload, or invented counter.

function telemetryOutcomeForReason(reason) {
  if (reason === 'transcript-unavailable') return 'transcript_unavailable';
  if (reason === 'unsupported-transcript') return 'token_snapshot_missing';
  if (reason === 'counter-reset' || reason === 'bounded-tail-without-baseline'
    || reason === 'inconsistent-total' || reason === 'source-mismatch') return 'transcript_ambiguous';
  if (reason === 'identity-rebaseline') return 'identity_rebaseline';
  return 'awaiting_post_turn_usage';
}

function terminalTelemetryOutcome(current, reconciliation) {
  if (current === 'stop_failure_without_usage') return current;
  if (isTelemetryOutcome(reconciliation) && reconciliation !== 'received') return reconciliation;
  if (isTelemetryOutcome(current) && current !== 'received' && current !== 'awaiting_post_turn_usage') return current;
  return 'session_closed_without_usage';
}

function recordLimitRecoveryTransitionHealth(state, previous, next) {
  const before = typeof previous === 'string' ? previous : 'disabled';
  const after = typeof next?.state === 'string' ? next.state : 'unavailable';
  if (before !== 'armed' && after === 'armed') incrementHealth(state, 'limit_recovery_armed');
  if (before !== 'waiting_for_reset' && after === 'waiting_for_reset') incrementHealth(state, 'limit_recovery_limit_observed');
  if (before !== 'resumed' && after === 'resumed') incrementHealth(state, 'limit_recovery_resumed');
  if (before !== 'canceled' && after === 'canceled') incrementHealth(state, 'limit_recovery_canceled');
  if (before !== 'unavailable' && after === 'unavailable') incrementHealth(state, 'limit_recovery_unavailable');
  const reasons = Array.isArray(next?.reason_codes) ? next.reason_codes : [];
  if (reasons.some((reason) => ['protocol_mismatch', 'transport_timeout', 'uncertain_resume', 'auth_lost'].includes(reason))) {
    incrementHealth(state, 'limit_recovery_protocol_errors');
  }
  if (reasons.includes('invalid_state')) incrementHealth(state, 'limit_recovery_state_drops');
}

function requiresIdentityRebaseline(state, runtime, sessionId, sourceId) {
  if (!sourceId || !/^[a-f0-9]{20}$/.test(sourceId)) return false;
  state.identity_rebaseline ??= blankIdentityRebaseline();
  const session = sessionIdentity(runtime, sessionId);
  if (!session) return false;
  let pending = state.identity_rebaseline.pending_sessions?.[session];
  if (!pending && state.identity_rebaseline.fallback_pending === true) {
    pending = { sources: {} };
    state.identity_rebaseline.pending_sessions[session] = pending;
    state.identity_rebaseline.fallback_pending = false;
  }
  if (!pending) return false;
  pending.sources ??= {};
  if (pending.sources[sourceId] === true) return false;
  pending.sources[sourceId] = true;
  return true;
}

function usableEnvironmentPath(value) {
  return isHostOwnedAbsolutePath(value);
}

/** Resolve only host-provided plugin data aliases; never infer a path. */
export function pluginDataRoot(env = {}) {
  const runtime = env?.SOMESTOKEN_RUNTIME === 'claude'
    ? 'claude'
    : env?.SOMESTOKEN_RUNTIME === 'codex'
      ? 'codex'
      : 'unknown';
  if (runtime === 'claude') {
    return ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA'].map((key) => env?.[key]).find(usableEnvironmentPath) ?? null;
  }
  if (runtime === 'codex') {
    // A declared Codex runtime must never borrow a Claude-owned root merely
    // because a parent process exported an unrelated compatibility variable.
    return usableEnvironmentPath(env?.PLUGIN_DATA) ? env.PLUGIN_DATA : null;
  }
  const roots = [...new Set(['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']
    .map((key) => env?.[key])
    .filter(usableEnvironmentPath))];
  return roots.length === 1 ? roots[0] : null;
}

export function readTranscriptTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { text: '', unreadable: true, truncated: false };
  }
  let fd;
  try {
    // Host transcript paths are input, not an authority to follow arbitrary
    // links. Fail closed when the platform cannot give the opened descriptor
    // a no-follow guarantee; a missing token snapshot is safer than reading a
    // redirected local file.
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!Number.isSafeInteger(noFollow)) throw new Error('no-follow-unavailable');
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error('transcript-not-regular-file');
    }
    const requestedBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0
      ? maxBytes
      : MAX_TAIL_BYTES;
    const size = stat.size;
    const length = Math.min(size, requestedBytes, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
    let text = buffer.toString('utf8');
    const truncated = size > length;
    if (truncated) {
      const newline = text.indexOf('\n');
      if (newline < 0) text = '';
      else text = text.slice(newline + 1);
    }
    return { text, unreadable: false, truncated };
  } catch {
    return { text: '', unreadable: true, truncated: false };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function readSnapshots(filePath, runtime = 'codex') {
  if (runtime === 'claude') {
    // Claude entries are per-message usage, unlike Codex cumulative snapshots.
    // A moving tail is never a cumulative source. Fail open beyond the bound.
    let fd;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('claude-source-bound');
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < buffer.length) {
        const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!n) throw new Error('short-read');
        offset += n;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('source-changed');
      return { unreadable:false, truncated:false, parsed:parseTokenSnapshots(buffer.toString('utf8')) };
    } catch {
      return { unreadable:true, truncated:false, parsed:parseTokenSnapshots('') };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const tail = readTranscriptTail(filePath);
  if (tail.unreadable) return { ...tail, parsed: parseTokenSnapshots('') };
  return { ...tail, parsed: parseTokenSnapshots(tail.text) };
}

function claudePromptOrdinal(state, input) {
  // Claude API failures can end a turn before a transcript token snapshot is
  // written. The bounded session event counter separates those turns without
  // hashing or retaining any content-bearing error field.
  const key = sessionKey(input?.session_id, 'claude');
  const count = key ? state?.advisor?.sessions?.[key]?.event_counts?.UserPromptSubmit : undefined;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function sessionGeneration(state, input, runtime = 'codex') {
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const key = sessionKey(input?.session_id, host);
  const generation = key ? state?.advisor?.sessions?.[key]?.generation : undefined;
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function sessionTotalsKey(sessionHash, generation = 0) {
  if (generation <= 0) return sessionHash;
  return hashId(`${sessionHash}:generation:${generation}`);
}

function stopTurnIdentity(state, input, snapshot, runtime) {
  const generation = sessionGeneration(state, input, runtime);
  const mainSourceId = sourceIdentity(runtime, input?.session_id, 'main', generation);
  const suppliedTurnId = safeOpaqueHostIdentifier(input?.turn_id);
  if (suppliedTurnId) return turnIdentity(runtime, input?.session_id, suppliedTurnId, generation, 'main', mainSourceId);
  if (runtime === 'claude') {
    const promptOrdinal = claudePromptOrdinal(state, input);
    if (promptOrdinal !== null) return turnIdentity(runtime, input?.session_id, `claude-prompt:${promptOrdinal}`, generation, 'main', mainSourceId);
    const snapshotCount = snapshot?.parsed?.snapshots?.length ?? 0;
    return turnIdentity(runtime, input?.session_id, `claude:${snapshotCount}`, generation, 'main', mainSourceId);
  }
  const snapshotCount = snapshot?.parsed?.snapshots?.length ?? 0;
  return turnIdentity(runtime, input?.session_id, `codex:${snapshotCount}`, generation, 'main', mainSourceId);
}

function claudePromptSnapshotIdentity(state, input, generation, session) {
  const promptOrdinal = claudePromptOrdinal(state, input);
  return promptOrdinal === null || !session
    ? null
    : hashId(`claude:final-message:${session}:g${generation}:prompt:${promptOrdinal}`);
}

function stageClaudeFinalSnapshot(state, input) {
  // Claude includes agent_id for subagent and --agent hook calls. A final
  // display from either is not safely attributable to the main Stop, so field
  // presence alone suppresses staging without inspecting or retaining it.
  if (Object.hasOwn(input ?? {}, 'agent_id')) return null;
  const source = readSnapshots(input?.transcript_path, 'claude');
  // A bounded tail without its own baseline cannot identify a complete turn.
  // Waiting for Stop remains safer than turning that partial file view into a
  // counter source.
  if (source.unreadable || source.truncated || !source.parsed?.latest?.usage) return null;
  const generation = sessionGeneration(state, input, 'claude');
  const suppliedTurnId = safeOpaqueHostIdentifier(input?.turn_id);
  // A session generation after an explicit reopen can receive delayed command
  // hooks from the prior generation. Prompt ordinals restart in the new
  // generation and cannot prove that a delayed final display belongs to its
  // new Stop. Preserve the first-generation fallback, but require the
  // documented host turn boundary after a reopen.
  if (generation > 0 && !suppliedTurnId) return null;
  const session = sessionIdentity('claude', input?.session_id);
  const sourceId = sourceIdentity('claude', input?.session_id, 'main', generation);
  const turnId = stopTurnIdentity(state, input, source, 'claude');
  const usage = persistedUsage(source.parsed.latest.usage, 'claude');
  if (!session || !sourceId || !turnId || !usage) return null;
  // Stop hooks do not document a turn_id, while MessageDisplay does. A
  // submitted-prompt ordinal is the shared, content-free fallback boundary.
  // Retain the display turn only as an invalidation marker, never as content.
  const stageKey = generation === 0
    ? claudePromptSnapshotIdentity(state, input, generation, session) ?? turnId
    : turnId;
  const lifecycleTurn = lifecycleTurnIdentity('claude', input?.session_id, input?.turn_id);
  state.claude_final_snapshots ??= {};
  state.claude_final_snapshots[stageKey] = {
    session,
    source_id: sourceId,
    session_generation: generation,
    ...(lifecycleTurn ? { lifecycle_turn_id: lifecycleTurn } : {}),
    usage: tokenFields(usage),
    accounting_basis: CLAUDE_ACCOUNTING_BASIS,
    compaction_count: Number.isSafeInteger(source.parsed.compactions) && source.parsed.compactions >= 0
      ? Math.min(source.parsed.compactions, MAX_HEALTH_COUNTER) : 0,
    staged_at: timestamp(),
  };
  return stageKey;
}

function stagedClaudeSnapshotSource(snapshot) {
  return {
    unreadable: false,
    truncated: false,
    staged_final_message: true,
    parsed: {
      snapshots: [],
      malformed: 0,
      latest: { usage: snapshot.usage },
      metadata: undefined,
      ponytail: undefined,
      compactions: snapshot.compaction_count,
    },
  };
}

function takeClaudeFinalSnapshot(state, input, turnId) {
  const snapshots = state.claude_final_snapshots;
  const generation = sessionGeneration(state, input, 'claude');
  const session = sessionIdentity('claude', input?.session_id);
  const sourceId = sourceIdentity('claude', input?.session_id, 'main', generation);
  const suppliedTurnId = safeOpaqueHostIdentifier(input?.turn_id);
  // A reopened session needs a host turn boundary on both display and Stop.
  // Without it, a late display from the prior generation is indistinguishable
  // from the current prompt and must not become a partial receipt.
  if (generation > 0 && !suppliedTurnId) {
    clearClaudeFinalSnapshots(state, session, generation);
    return null;
  }
  const promptKey = generation === 0
    ? claudePromptSnapshotIdentity(state, input, generation, session)
    : null;
  const keys = [...new Set([turnId, promptKey].filter(Boolean))];
  for (const key of keys) {
    const staged = snapshots?.[key];
    if (!staged || typeof staged !== 'object') continue;
    delete snapshots[key];
    const now = timestamp();
    if (!session || !sourceId
      || staged.session !== session
      || staged.source_id !== sourceId
      || staged.session_generation !== generation
      || staged.accounting_basis !== CLAUDE_ACCOUNTING_BASIS
      || !Number.isSafeInteger(staged.staged_at)
      || (now >= staged.staged_at && now - staged.staged_at > CLAUDE_FINAL_SNAPSHOT_TTL_MS)) continue;
    const usage = persistedUsage(staged.usage, 'claude');
    if (usage) return stagedClaudeSnapshotSource({ ...staged, usage: tokenFields(usage) });
  }
  return null;
}

function clearClaudeFinalSnapshots(state, session, generation) {
  if (!state.claude_final_snapshots || !session) return;
  for (const [turnId, entry] of Object.entries(state.claude_final_snapshots)) {
    if (entry?.session === session && entry.session_generation === generation) delete state.claude_final_snapshots[turnId];
  }
}

function invalidateClaudeFinalSnapshots(state, input, eventName) {
  if (!CLAUDE_FINAL_SNAPSHOT_INVALIDATING_EVENTS.has(eventName)) return;
  const generation = sessionGeneration(state, input, 'claude');
  const session = sessionIdentity('claude', input?.session_id);
  if (!session) return;
  const suppliedTurn = safeOpaqueHostIdentifier(input?.turn_id);
  const sourceId = sourceIdentity('claude', input?.session_id, 'main', generation);
  if (suppliedTurn && sourceId) {
    const turnId = turnIdentity('claude', input?.session_id, suppliedTurn, generation, 'main', sourceId);
    if (turnId) delete state.claude_final_snapshots?.[turnId];
    const lifecycleTurn = lifecycleTurnIdentity('claude', input?.session_id, suppliedTurn);
    for (const [key, entry] of Object.entries(state.claude_final_snapshots ?? {})) {
      if (entry?.session === session
        && entry.session_generation === generation
        && entry.lifecycle_turn_id === lifecycleTurn) delete state.claude_final_snapshots[key];
    }
    return;
  }
  // An unscoped tool event cannot safely be assigned to a staged main turn.
  // Drop only its session/generation candidates rather than risk a stale
  // final-message snapshot crossing an unknown tool boundary.
  clearClaudeFinalSnapshots(state, session, generation);
}

function invalidateClaudeFinalSnapshotsBySafeContext(state, session, generation, invalidation) {
  if (!state?.claude_final_snapshots || typeof session !== 'string' || !/^[a-f0-9]{20}$/.test(session)) return;
  if (!invalidation || invalidation.clear_session === true) {
    clearClaudeFinalSnapshots(state, session, generation);
    return;
  }
  if (typeof invalidation.turn_id === 'string' && /^[a-f0-9]{20}$/.test(invalidation.turn_id)) {
    delete state.claude_final_snapshots[invalidation.turn_id];
  }
  if (typeof invalidation.lifecycle_turn_id === 'string' && /^[a-f0-9]{20}$/.test(invalidation.lifecycle_turn_id)) {
    for (const [key, entry] of Object.entries(state.claude_final_snapshots)) {
      if (entry?.session === session
        && entry.session_generation === generation
        && entry.lifecycle_turn_id === invalidation.lifecycle_turn_id) delete state.claude_final_snapshots[key];
    }
  }
}

function sessionIdentity(runtime, sessionId) {
  return hashOpaqueHostIdentifier(safeLifecycleId(sessionId), runtimeHost(runtime)) ?? null;
}

function threadIdentity(kind, sourceId) {
  return typeof sourceId === 'string' && /^[a-f0-9]{20}$/.test(sourceId) ? `${kind}:${sourceId}` : null;
}

function lifecycleAgentIdentity(runtime, sessionId, agentId) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(sessionId);
  const agent = safeLifecycleId(agentId);
  return session && agent ? hashId(`${host}:lifecycle-agent:${session}:${agent}`) : null;
}

function childIdentity(input, runtime, generation = 0) {
  const host = runtimeHost(runtime);
  const session = safeLifecycleId(input?.session_id) ?? 'unknown-session';
  const agent = safeLifecycleId(input?.agent_id);
  const turn = safeLifecycleId(input?.turn_id) ?? 'unknown-turn';
  const generationPart = Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  return {
    agentHash: hashId(`${host}:agent:${session}:g${generationPart}:${agent ?? `unknown-agent:${turn}`}`),
    sourceId: agent ? sourceIdentity(runtime, input?.session_id, 'subagent', generation, agent, input?.turn_id) ?? undefined : undefined,
    lifecycleAgentId: agent ? lifecycleAgentIdentity(runtime, input?.session_id, agent) ?? undefined : undefined,
    lifecycleTurnId: lifecycleTurnIdentity(runtime, input?.session_id, input?.turn_id) ?? undefined,
  };
}

function shouldRefreshActivePublicBridge(state, eventName, efficiency, now = timestamp()) {
  if (!NON_DURABLE_EVENTS.has(eventName)) return false;
  // A public heartbeat must never revive a closed or unscoped session. The
  // event has already been normalized and recorded before this decision.
  if (!efficiency || efficiency.missing_session_identity || efficiency.late_event || efficiency.ignored_session_end) return false;
  const lastAttemptedAt = state?.public_bridge?.last_attempted_at;
  if (!Number.isSafeInteger(lastAttemptedAt) || lastAttemptedAt < 0) return true;
  if (!Number.isSafeInteger(now) || now < 0) return false;
  // If the local wall clock moved backwards, one replacement snapshot resets
  // the bounded lease to the current clock without treating it as telemetry.
  // A failed write still consumes this lease: otherwise a permission error
  // would synchronously retry on every high-frequency tool event.
  return now < lastAttemptedAt || now - lastAttemptedAt >= PUBLIC_BRIDGE_ACTIVE_REFRESH_MS;
}

function hookMetadata(input, role) {
  if (!input || typeof input !== 'object') return { status: 'unknown', confidence: 'low' };
  const values = { source: 'hook' };
  const nested = [input.agent_output, input.agent]
    .find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? {};
  for (const [output, keys] of Object.entries({
    model: ['model', 'resolved_model', 'resolvedModel'],
    reasoning_effort: ['reasoning_effort', 'effort'],
    codex_mode: ['codex_mode', 'execution_mode', 'collaboration_mode'],
    permission_mode: ['permission_mode'],
    agent_type: ['agent_type'],
    // A host-supplied agent name is presentation/content, not a structured
    // role. Never let it cross into persisted metadata.
    agent_role: ['agent_role'],
    service_tier: ['service_tier', 'serviceTier', 'effective_service_tier', 'effectiveServiceTier'],
    requested_service_tier: ['requested_service_tier', 'requestedServiceTier'],
  })) {
    for (const key of keys) {
      const value = typeof (input[key] ?? nested[key]) === 'string' ? (input[key] ?? nested[key]).trim() : '';
      if (value) { values[output] = value; break; }
    }
  }
  const hasField = Object.keys(values).some((key) => key !== 'source');
  if (!hasField) return { status: 'unknown', confidence: 'low' };
  if (role && !values.agent_type) values.agent_type = role;
  return sanitizeMetadata(values) ?? { status: 'unknown', confidence: 'low' };
}

function updateThread(state, key, transcriptPath, sourceId, sourceOverride = null, identity = {}) {
  const prior = state.threads[key];
  const source = sourceOverride ?? readSnapshots(transcriptPath, identity.runtime);
  const parsed = source.parsed;
  incrementHealth(state, 'token_events_seen', parsed.snapshots.length);
  incrementHealth(state, 'malformed_events', parsed.malformed);
  if (source.unreadable || !parsed.latest) {
    return { valid: false, ambiguous: false, reason: source.unreadable ? 'transcript-unavailable' : 'unsupported-transcript', metadata: prior?.metadata, ponytail: parsed.ponytail };
  }
  const current = parsed.latest.usage;
  const previous = prior?.usage;
  const delta = deltaUsage(previous, current);
  const reset = Boolean(previous && delta === null);
  const compactionBoundary = parsed.compactions > (prior?.compaction_count ?? 0);
  state.threads[key] = {
    schema_version: SCHEMA_VERSION,
    thread_id: key,
    source_id: sourceId,
    usage: current,
    metadata: mergeRuntimeMetadata(prior?.metadata, parsed.metadata),
    ponytail: parsed.ponytail,
    ...(identity.runtime === 'claude' ? { accounting_basis:CLAUDE_ACCOUNTING_BASIS } : {}),
    compaction_count: parsed.compactions,
    updated_at: timestamp(),
  };
  if (identity.runtime === 'claude' && prior && prior.accounting_basis !== CLAUDE_ACCOUNTING_BASIS) {
    return {valid:false,ambiguous:true,reason:'identity-rebaseline',current,metadata:parsed.metadata};
  }
  if (identity.runtime === 'codex' && parsed.ledger?.present && identity.turn_id) {
    const matches = parsed.ledger.turns.filter(t =>
      t.session === hashOpaqueHostIdentifier(identity.session_id, 'ledger:session')
      && t.turn === hashOpaqueHostIdentifier(identity.turn_id, 'ledger:turn'));
    const turn = matches.length === 1 ? matches[0] : null;
    if (!turn?.usage || turn.status === 'unavailable') return {valid:false,ambiguous:true,reason:'source-mismatch',current,metadata:parsed.metadata};
    // The explicit host turn total is independent of a legacy cumulative
    // baseline, model switch or compaction reset. Do not subtract that baseline.
    return {valid:true,ambiguous:turn.status !== 'exact',delta:turn.usage,current,
      metadata:parsed.metadata,ponytail:parsed.ponytail,usage_source:'codex_structured_ledger'};
  }
  if (prior?.accounting_basis==='structured_hook_v1'||requiresIdentityRebaseline(state, identity.runtime, identity.session_id, sourceId)) {
    return {
      valid: false,
      ambiguous: true,
      reason: 'identity-rebaseline',
      current,
      metadata: mergeRuntimeMetadata(prior?.metadata, parsed.metadata),
      ponytail: parsed.ponytail,
    };
  }
  if (reset) {
    incrementHealth(state, 'counter_resets');
    return { valid: false, ambiguous: true, reason: 'counter-reset', current, metadata: mergeRuntimeMetadata(prior?.metadata, parsed.metadata), ponytail: parsed.ponytail };
  }
  const firstSnapshotTruncated = !previous && source.truncated;
  const inconsistent = !current.consistent || Boolean(previous && delta && delta.consistent !== true);
  return {
    valid: !firstSnapshotTruncated,
    ambiguous: firstSnapshotTruncated || inconsistent,
    compactionBoundary,
    reason: firstSnapshotTruncated ? 'bounded-tail-without-baseline' : (inconsistent ? 'inconsistent-total' : undefined),
    delta: delta ?? current,
    current,
    metadata: mergeRuntimeMetadata(prior?.metadata, parsed.metadata),
    ponytail: parsed.ponytail,
  };
}

function ensureTurn(state, turnHash) {
  state.turns[turnHash] ??= {
    turn_id: turnHash,
    main: null,
    subagents: {},
    overflow_count: 0,
    receipt: null,
    updated_at: timestamp(),
  };
  return state.turns[turnHash];
}

function ensureScope(state, scopeHash) {
  state.scopes[scopeHash] ??= {
    scope_id: scopeHash,
    closed: false,
    generation: 0,
    overflow_count: 0,
    active: {},
    completed: {},
    updated_at: timestamp(),
  };
  return state.scopes[scopeHash];
}

function usageQualityForStatus(status) {
  return status === 'exact' || status === 'partial' ? status : 'unavailable';
}

function hostUsageCoverage(runtime, authMode) {
  if (runtime === 'claude' && authMode === 'subscription') return 'shared_pool_unknown';
  return 'somestoken_observed';
}

function buildReceiptUsageLayers({ runtime, status, summed, model, input, env }) {
  const quality = usageQualityForStatus(status);
  const authMode = runtime === 'claude' ? detectClaudeAuthMode(input, env) : 'codex';
  const coverage = hostUsageCoverage(runtime, authMode);
  const observed = quality === 'unavailable'
    ? { quality, coverage }
    : { ...tokenFields(summed), quality, coverage };
  let calculated = { quality: 'unavailable', calculation_quality: 'unavailable' };
  if (runtime === 'codex') {
    const result = calculateCodexCredits(observed, { model, quality });
    calculated = { ...result, quality: result.calculation_quality ?? 'unavailable' };
  } else if (authMode !== 'subscription' && authMode !== 'unknown') {
    const apiRates = input?.api_rates && typeof input.api_rates === 'object' ? input.api_rates : null;
    if (apiRates) {
      const result = calculateApiCost(observed, { ...apiRates, quality });
      calculated = { ...result, quality: result.calculation_quality ?? 'unavailable' };
    }
  }
  const usageLayers = normalizeUsageLayers({ observed, calculated, coverage, comparison_mode: 'relative_only' });
  return { usageLayers, coverage, authMode };
}

function structuredPostTurnUsage(input, runtime) {
  const candidates = [input?.usage, input?.post_turn_usage, input?.turn_usage];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const normalized = runtime === 'claude' ? normalizeClaudeUsage(candidate) : normalizeCodexUsage(candidate);
    if (normalized.quality !== 'unavailable') return normalized;
  }
  return null;
}

function telemetryReconciliation(source, attempts = 1, outcome = undefined) {
  const normalizedSource = TELEMETRY_SOURCES.has(source) ? source : 'none';
  const normalizedState = normalizedSource === 'none' ? 'pending_post_turn' : 'received';
  const normalizedOutcome = normalizedState === 'received'
    ? 'received'
    : isTelemetryOutcome(outcome) && outcome !== 'received'
      ? outcome
      : 'awaiting_post_turn_usage';
  return {
    state: normalizedState,
    source: normalizedSource,
    attempts: Math.min(MAX_TURNS, Math.max(1, Number.isSafeInteger(attempts) ? attempts : 1)),
    outcome: normalizedOutcome,
  };
}

function planComparisonForReceipt(state, runtime, status, summed) {
  const provider = runtime === 'claude' ? 'claude' : 'codex';
  const selectedPlan = state.usage?.selected_plan?.provider === provider
    && state.usage.selected_plan.id && state.usage.selected_plan.id !== 'unknown'
    ? state.usage.selected_plan.id : undefined;
  const configuredPlan = state.usage?.config?.plan?.provider === provider
    ? state.usage.config.plan
    : null;
  const quota = state.usage?.quota_snapshots?.at(-1);
  const configuredMode = configuredPlan?.comparison_mode === 'manual_capacity'
    ? 'manual_capacity'
    : configuredPlan?.comparison_mode === 'relative_only'
      ? 'relative_only'
      : quota?.measurement_basis === 'host_percent'
        ? 'unavailable'
      : quota?.quality === 'exact' && quota?.limit_units > 0 ? 'host_quota' : 'relative_only';
  const manualCapacity = configuredPlan?.manual_capacity;
  return status === 'unavailable' ? null : buildPlanComparisons({
    provider,
    observed_units: summed.total_tokens,
    base_capacity_units: manualCapacity?.capacity_units,
    unit: 'tokens',
    capacity_unit: manualCapacity?.unit ?? quota?.unit,
    window_type: manualCapacity?.window_type ?? quota?.window_type,
    capacity_window_type: manualCapacity?.window_type ?? quota?.window_type,
    quota,
    selected_plan: selectedPlan ?? configuredPlan?.id,
    comparison_mode: configuredMode,
  });
}

function receiptSnapshotIdentity(receipt) {
  return typeof receipt?.turn_id === 'string' && /^[a-f0-9]{20}$/.test(receipt.turn_id)
    ? receipt.turn_id
    : null;
}

function recordUsageSnapshot(state, runtime, usageLayers, receipt = null, options = {}) {
  if (!usageLayers || usageLayers.observed?.quality === 'unavailable') {
    incrementHealth(state, 'usage_snapshots_rejected');
    return false;
  }
  state.usage ??= blankUsageState();
  state.usage.snapshots ??= [];
  const turnId = receiptSnapshotIdentity(receipt);
  const snapshot = {
    host: runtime,
    layers: usageLayers,
    window_type: 'turn',
    source: 'somestoken',
    ...(turnId ? { turn_id: turnId } : {}),
    created_at: Number.isSafeInteger(receipt?.created_at) && receipt.created_at >= 0 ? receipt.created_at : timestamp(),
  };
  if (options.reconcile === true && turnId) {
    let index = -1;
    for (let candidate = state.usage.snapshots.length - 1; candidate >= 0; candidate -= 1) {
      const entry = state.usage.snapshots[candidate];
      if (entry?.host === runtime && entry?.turn_id === turnId) {
        index = candidate;
        break;
      }
    }
    if (index >= 0) {
      const prior = state.usage.snapshots[index];
      state.usage.snapshots[index] = { ...snapshot, created_at: prior.created_at ?? snapshot.created_at };
      return true;
    }
    // A receipt with prior observed usage must already have a uniquely
    // identified snapshot. Older snapshots lack this identity, so appending
    // would turn one receipt correction into two observed usage records.
    const previousObservedQuality = options.previousUsageLayers?.observed?.quality;
    if (previousObservedQuality === 'exact' || previousObservedQuality === 'partial') return false;
  }
  state.usage.snapshots.push(snapshot);
  state.usage.snapshots = state.usage.snapshots.slice(-MAX_USAGE_SNAPSHOTS);
  incrementHealth(state, 'usage_snapshots_seen');
  const calculationQuality = usageLayers?.calculated?.calculation_quality ?? usageLayers?.calculated?.quality;
  if (calculationQuality === 'exact' || calculationQuality === 'partial') incrementHealth(state, 'credit_calculations');
  if (calculationQuality === 'partial') incrementHealth(state, 'credit_calculation_partial');
  if (calculationQuality === 'unavailable') incrementHealth(state, 'credit_calculation_unavailable');
  if (usageLayers?.calculated?.unpriced_components?.includes('model_rate_unavailable')) incrementHealth(state, 'rate_profile_misses');
  return true;
}

function recordQuotaSnapshot(state, input) {
  const raw = input?.quota_snapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const snapshot = normalizeQuotaSnapshot(raw, { now: new Date().toISOString() });
  state.usage ??= blankUsageState();
  state.usage.quota_snapshots ??= [];
  state.usage.quota_snapshots.push(snapshot);
  state.usage.quota_snapshots = state.usage.quota_snapshots.slice(-MAX_QUOTA_SNAPSHOTS);
  incrementHealth(state, 'quota_snapshots_seen');
  if (snapshot.stale === true || snapshot.reason_codes?.includes('stale_quota_snapshot')) incrementHealth(state, 'quota_snapshots_stale');
  if (snapshot.coverage === 'shared_pool_unknown' || snapshot.quota_scope === 'unknown') incrementHealth(state, 'quota_scope_unknown');
  return snapshot;
}

function usageAlertSet(state) {
  state.usage ??= blankUsageState();
  state.usage.alerts_seen ??= {};
  return new Set(Object.keys(state.usage.alerts_seen));
}

function rememberUsageAlerts(state, seen) {
  state.usage.alerts_seen = boundedAlertMap(Object.fromEntries([...seen].slice(-256).map((key) => [key, 1])));
}

function recordUsageThresholdAlerts(state, snapshot) {
  if (!snapshot || snapshot.quality !== 'exact' || typeof snapshot.used_percent !== 'number') return [];
  const config = state.usage?.config;
  if (config?.usage_alerts?.enabled === false) return [];
  const seen = usageAlertSet(state);
  const windowKey = `${snapshot.window_type ?? 'host_defined'}:${snapshot.resets_at ?? snapshot.window_started_at ?? snapshot.snapshot_at ?? 'unknown'}`;
  const alerts = alertThresholds(snapshot.used_percent, config?.usage_alerts?.thresholds_percent, windowKey, seen);
  rememberUsageAlerts(state, seen);
  if (alerts.length) incrementHealth(state, 'usage_threshold_warnings', alerts.length);
  return alerts;
}

function receiptTokenContribution(receipt) {
  return (receipt?.status === 'exact' || receipt?.status === 'partial')
    && Number.isSafeInteger(receipt?.total_tokens) && receipt.total_tokens >= 0
    ? receipt.total_tokens
    : null;
}

function receiptCreditContribution(usageLayers) {
  const quality = usageLayers?.calculated?.calculation_quality ?? usageLayers?.calculated?.quality;
  const value = usageLayers?.calculated?.calculated_codex_credits;
  return (quality === 'exact' || quality === 'partial')
    && typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function saturatingNonNegativeSum(left, right) {
  const first = Math.min(Number.MAX_SAFE_INTEGER, nonNegativeNumber(left));
  const second = Math.min(Number.MAX_SAFE_INTEGER, nonNegativeNumber(right));
  return first > Number.MAX_SAFE_INTEGER - second ? Number.MAX_SAFE_INTEGER : first + second;
}

function replaceSessionContribution(total, previous, current) {
  if (current === null) {
    return typeof total === 'number' && Number.isFinite(total) && total >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, total)
      : null;
  }
  const retained = Math.max(0,
    Math.min(Number.MAX_SAFE_INTEGER, nonNegativeNumber(total))
    - Math.min(Number.MAX_SAFE_INTEGER, nonNegativeNumber(previous)));
  return saturatingNonNegativeSum(retained, current);
}

function updateSessionUsageTotals(state, receipt, usageLayers, options = {}) {
  const sessionHash = typeof receipt?.session === 'string' && /^[a-f0-9]{20}$/.test(receipt.session) ? receipt.session : null;
  if (!sessionHash) return null;
  const generation = Number.isSafeInteger(receipt?.session_generation) && receipt.session_generation >= 0 ? receipt.session_generation : 0;
  const totalsKey = sessionTotalsKey(sessionHash, generation);
  state.usage ??= blankUsageState();
  state.usage.session_totals ??= {};
  const prior = state.usage.session_totals[totalsKey] ?? {};
  const samePriorReceipt = options.previousReceipt?.session === sessionHash
    && (Number.isSafeInteger(options.previousReceipt?.session_generation) ? options.previousReceipt.session_generation : 0) === generation;
  const previousTokens = samePriorReceipt ? receiptTokenContribution(options.previousReceipt) : null;
  const previousCredits = samePriorReceipt ? receiptCreditContribution(options.previousUsageLayers) : null;
  const tokens = replaceSessionContribution(prior.tokens, previousTokens, receiptTokenContribution(receipt));
  const calculatedCredits = replaceSessionContribution(prior.calculated_credits, previousCredits, receiptCreditContribution(usageLayers));
  if (tokens === null && calculatedCredits === null) {
    return {
      sessionHash,
      generation,
      totalsKey,
      totals: { tokens: null, calculated_credits: null },
    };
  }
  const totals = {
    ...(tokens === null ? {} : { tokens }),
    ...(calculatedCredits === null ? {} : { calculated_credits: calculatedCredits }),
    updated_at: Number.isSafeInteger(receipt?.created_at) && receipt.created_at >= 0 ? receipt.created_at : timestamp(),
  };
  state.usage.session_totals[totalsKey] = totals;
  const entries = Object.entries(state.usage.session_totals).slice(-MAX_SESSION_TOTALS);
  state.usage.session_totals = Object.fromEntries(entries);
  return { sessionHash, generation, totalsKey, totals };
}

function recordLocalBudgetAlerts(state, receipt, usageLayers) {
  const budgets = state.usage?.config?.local_budgets;
  if (!budgets || typeof budgets !== 'object') return [];
  const seen = usageAlertSet(state);
  const turnKey = `turn:${receipt?.created_at ?? 'unknown'}`;
  const alerts = [
    ...localBudgetAlerts(receipt?.total_tokens, budgets.max_tokens_per_turn, 'turn', turnKey, seen),
    ...localBudgetAlerts(usageLayers?.calculated?.calculated_codex_credits, budgets.max_calculated_credits_per_turn, 'turn', turnKey, seen),
    ...localBudgetAlerts(Math.max(0, (receipt?.agents ?? 1) - 1), budgets.max_subagents_per_turn, 'turn', turnKey, seen),
  ];
  const session = updateSessionUsageTotals(state, receipt, usageLayers);
  if (session) {
    const sessionKey = `session:${session.totalsKey}`;
    alerts.push(
      ...localBudgetAlerts(session.totals.tokens, budgets.max_tokens_per_session, 'session', sessionKey, seen),
      ...localBudgetAlerts(session.totals.calculated_credits, budgets.max_calculated_credits_per_session, 'session', sessionKey, seen),
      ...localBudgetAlerts(
        state.efficiency?.warnings?.filter((warning) => warning.session === session.sessionHash
          && (Number.isSafeInteger(warning.session_generation) ? warning.session_generation : 0) === session.generation).length ?? 0,
        budgets.max_efficiency_warnings_per_session,
        'session',
        sessionKey,
        seen,
      ),
    );
  }
  rememberUsageAlerts(state, seen);
  if (alerts.length) incrementHealth(state, 'usage_threshold_warnings', alerts.length);
  return alerts;
}

function receiptComparableTokens(receipt) {
  const layers = receipt?.usage_layers;
  const observed = layers?.observed;
  return receipt?.status === 'exact'
    && observed?.quality === 'exact'
    && Number.isSafeInteger(observed.total_tokens)
    && observed.total_tokens >= 0
    ? observed.total_tokens : null;
}

function annotateUsageOutlier(state, receipt) {
  const current = receiptComparableTokens(receipt);
  if (current === null) return false;
  const model = receipt.metadata?.model ?? 'unknown';
  const effort = receipt.metadata?.reasoning_effort ?? 'unknown';
  const minimum = state.usage?.config?.efficiency?.minimum_baseline_receipts ?? 10;
  const prior = state.receipts.filter((entry) => (
    receiptComparableTokens(entry) !== null
    && (entry.metadata?.model ?? 'unknown') === model
    && (entry.metadata?.reasoning_effort ?? 'unknown') === effort
  )).slice(-100).map(receiptComparableTokens);
  if (prior.length < minimum) return false;
  const sorted = [...prior].sort((a, b) => a - b);
  const median = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))];
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.min(deviations.length - 1, Math.floor(deviations.length / 2))] ?? 0;
  const threshold = median + (3 * Math.max(mad, 1));
  if (current <= threshold || current <= median) return false;
  const efficiency = receipt.efficiency && typeof receipt.efficiency === 'object' ? receipt.efficiency : {};
  receipt.efficiency = normalizeEfficiencyResult({
    ...efficiency,
    reason_codes: [...new Set([...(efficiency.reason_codes ?? []), 'usage_outlier'])],
    evidence_counts: { ...(efficiency.evidence_counts ?? {}), usage_outlier: Math.min(1_000_000, (efficiency.evidence_counts?.usage_outlier ?? 0) + 1) },
    avoidable_usage: 'unmeasured',
  });
  return true;
}

function observeEfficiencyCapability(state, input, normalized, eventName, runtime, acceptance = {}, options = {}) {
  state.advisor ??= createAdvisorState();
  if (!state.advisor.capabilities?.records || Object.keys(state.advisor.capabilities.records).length === 0) state.advisor.capabilities = createCapabilityRegistry();
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const hostVersion = options.host_version ?? input?.host_version;
  if (typeof hostVersion === 'string' && /^[A-Za-z0-9._:+-]{1,40}$/.test(hostVersion)) state.advisor.capabilities.host_versions[host] = hostVersion;
  if ((state.health?.capabilities_declared ?? 0) === 0) incrementHealth(state, 'capabilities_declared', listCapabilities(state.advisor.capabilities).length);
  const fields = Array.isArray(options.fields) ? options.fields : capabilityFields(input, normalized);
  const observed = observeCapability(state.advisor.capabilities, {
    host,
    event: eventName,
    fields,
    live: acceptance.enabled === true,
    at: timestamp(),
  });
  if (observed.support === 'observed') incrementHealth(state, 'capabilities_observed');
  if (observed.support === 'live_verified') incrementHealth(state, 'capabilities_live_verified');
  if (observed.support === 'missing_required_fields') incrementHealth(state, 'missing_required_fields');
  if (observed.support === 'unavailable') incrementHealth(state, 'capability_misses');
  return observed;
}

function recordAcceptanceObservation(state, input, eventName, runtime, normalized, acceptance = {}) {
  if (acceptance.enabled !== true) return;
  state.advisor ??= createAdvisorState();
  state.advisor.acceptance_windows = recoverAcceptanceWindows(state.advisor.acceptance_windows);
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const scenario = acceptance.scenario ?? 'extended-events';
  let window = state.advisor.acceptance_windows.find((entry) => entry.state === 'open' && entry.host === host && entry.scenario === scenario);
  if (!window) {
    window = createAcceptanceWindow({ host, scenario, host_version: state.advisor.capabilities?.host_versions?.[host] });
    state.advisor.acceptance_windows.push(window);
    incrementHealth(state, 'acceptance_windows_started');
  }
  recordAcceptanceEvent(window, { ...input, ...normalized, event_type: eventName });
  if (eventName === 'SessionEnd') {
    closeAcceptanceWindow(window, { state: 'completed' });
    incrementHealth(state, 'acceptance_windows_completed');
  }
  state.advisor.acceptance_windows = recoverAcceptanceWindows(state.advisor.acceptance_windows).slice(-8);
}

function provenanceForResult(state, result, events, runtime) {
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const capabilities = {};
  for (const record of listCapabilities(state.advisor?.capabilities)) {
    if (record.host === host) capabilities[`${host}.${record.event}`] = record.support;
  }
  return buildProvenance(result.reason_codes, {
    host,
    capabilities,
    observed_events: [...new Set(events.map((entry) => entry.event_type))],
    observed_fields: Object.fromEntries(events.map((entry) => [`${host}.${entry.event_type}`, Object.keys(entry)])),
  });
}

function recordEfficiencyEvent(state, input, eventName, runtime, options = {}) {
  const normalized = options.normalized
    ?? (runtime === 'claude'
      ? normalizeClaudeHook({ ...(input ?? {}), hook_event_name: eventName })
      : normalizeCodexHook({ ...(input ?? {}), hook_event_name: eventName }));
  if (!normalized) {
    incrementHealth(state, 'efficiency_events_dropped');
    incrementHealth(state, 'capability_misses');
    return null;
  }
  const event = { ...normalized, timestamp: normalized.timestamp ?? timestamp() };
  observeEfficiencyCapability(state, input, event, eventName, runtime, options.acceptance);
  recordAcceptanceObservation(state, input, eventName, runtime, event, options.acceptance);
  // A safe host session id is the minimum cross-event boundary. Without it,
  // even a content-free fallback key could merge unrelated host sessions.
  // Preserve capability/acceptance evidence, but create neither an efficiency
  // scope nor a receipt/source graph from an unscoped lifecycle event.
  if (!safeLifecycleId(input?.session_id)) return { missing_session_identity: true };
  const sessionRecord = recordSessionEvent(state.advisor, {
    host: runtime === 'claude' ? 'claude' : 'codex',
    session_id: input?.session_id,
    event_type: eventName,
    timestamp: event.timestamp,
    ...(runtime === 'claude' ? { session_start_source: input?.source } : {}),
  });
  if (sessionRecord?.session_start_before_end) {
    incrementHealth(state, 'session_start_before_end');
    const priorSessionHash = sessionIdentity(runtime, input?.session_id);
    if (priorSessionHash && Number.isSafeInteger(sessionRecord.prior_generation) && sessionRecord.prior_generation >= 0) {
      // The documented resume/clear SessionStart is an authoritative boundary
      // for the prior generation when its SessionEnd command arrives late.
      // Terminalize only its already-pending receipts; never attach that
      // generation to the fresh session or fabricate a usage value.
      finalizePendingTelemetry(state, priorSessionHash, sessionRecord.prior_generation, 'session_closed_without_usage');
    }
  }
  if (sessionRecord?.ignored_prior_session_end) {
    if (sessionRecord.clock_anomaly) incrementHealth(state, 'clock_anomalies');
    incrementHealth(state, 'stale_session_end_ignored');
    return { ignored_session_end: true };
  }
  if (sessionRecord?.duplicate_session_start) {
    // Preserve raw lifecycle observation for capability/acceptance evidence,
    // but do not let a coalesced resume/clear duplicate inflate the
    // structural efficiency window or create a spurious detector signal.
    if (sessionRecord.clock_anomaly) incrementHealth(state, 'clock_anomalies');
    incrementHealth(state, 'duplicate_events');
    return { duplicate_session_start: true };
  }
  if (sessionRecord?.closed_at !== null && sessionRecord?.closed_at !== undefined && eventName !== 'SessionEnd') {
    incrementHealth(state, 'late_events_after_close');
    return { late_event: true };
  }
  const generation = sessionRecord?.generation ?? sessionGeneration(state, input, runtime);
  const scopedIdentity = scopeIdentity(runtime, input?.session_id, input?.turn_id, generation);
  const generationIdentity = event.scope_id && generation > 0 ? hashId(`${event.scope_id}:g${generation}`) : event.scope_id;
  const scopeId = scopedIdentity
    ?? fallbackScopeIdentity(runtime, input?.session_id, generation)
    ?? generationIdentity
    ?? hashId(`${runtime}:event:${eventName}:g${generation}`);
  event.scope_id = scopeId;
  return recordScopedEfficiencyEvent(state, input, eventName, runtime, event, {
    session: sessionIdentity(runtime, input?.session_id),
    generation,
    scope_id: scopeId,
  });
}

function recordScopedEfficiencyEvent(state, input, eventName, runtime, event, context = {}) {
  const scopeId = typeof context.scope_id === 'string' && /^[a-f0-9]{20}$/.test(context.scope_id)
    ? context.scope_id
    : null;
  const session = typeof context.session === 'string' && /^[a-f0-9]{20}$/.test(context.session)
    ? context.session
    : null;
  const generation = Number.isSafeInteger(context.generation) && context.generation >= 0
    ? context.generation
    : 0;
  if (!scopeId) {
    incrementHealth(state, 'efficiency_events_dropped');
    return null;
  }
  state.efficiency ??= blankEfficiencyState();
  state.efficiency.scopes ??= {};
  state.efficiency.scopes[scopeId] ??= [];
  const events = state.efficiency.scopes[scopeId];
  const prior = events.at(-1)?.timestamp;
  if (Number.isSafeInteger(prior) && event.timestamp < prior) incrementHealth(state, 'clock_anomalies');
  events.push(event);
  if (events.length > MAX_EFFICIENCY_EVENTS) {
    const dropped = events.length - MAX_EFFICIENCY_EVENTS;
    events.splice(0, dropped);
    incrementHealth(state, 'efficiency_retention_drops', dropped);
    incrementHealth(state, 'retention_drops', dropped);
  }
  const scopeKeys = Object.keys(state.efficiency.scopes);
  if (scopeKeys.length > MAX_EFFICIENCY_SCOPES) {
    const dropped = scopeKeys.length - MAX_EFFICIENCY_SCOPES;
    for (const key of scopeKeys.slice(0, dropped)) delete state.efficiency.scopes[key];
    incrementHealth(state, 'state_retention_drops', dropped);
    incrementHealth(state, 'retention_drops', dropped);
  }
  const priorWarning = state.efficiency.warnings?.some((warning) => warning.scope_id === scopeId && warning.classification !== 'normal') ?? false;
  const result = detectEfficiency(events, {
    stop_continuation_watch: 2,
    same_agent_respawn_watch: 4,
    same_tool_repeat_watch: 6,
    pending_source_age_ms: 600_000,
    prior_warning: priorWarning,
  });
  const provenance = provenanceForResult(state, result, events, runtime);
  const resultWithEvidence = provenance.evidence_quality === 'insufficient_evidence' && result.reason_codes.length > 0
    ? { ...result, classification: 'insufficient_evidence', provenance }
    : { ...result, provenance };
  const warningEligible = ['watch', 'likely_loop', 'runaway_risk'].includes(resultWithEvidence.classification);
  const now = event.timestamp;
  const lastWarning = state.efficiency.warnings?.filter((warning) => warning.scope_id === scopeId).at(-1);
  const warningEmitted = warningEligible && (!lastWarning || now - lastWarning.created_at >= EFFICIENCY_WARNING_COOLDOWN_MS);
  if (warningEmitted) {
    state.efficiency.warnings ??= [];
    state.efficiency.warnings.push({
      scope_id: scopeId,
      ...(session ? { session } : {}),
      ...(generation > 0 ? { session_generation: generation } : {}),
      classification: resultWithEvidence.classification,
      created_at: now,
    });
    state.efficiency.warnings = state.efficiency.warnings.slice(-MAX_EFFICIENCY_WARNINGS);
    incrementHealth(state, 'efficiency_warnings');
  }
  const resultWithWarning = { ...resultWithEvidence, warning_emitted: warningEmitted };
  recordOptimizationObservation(state, input, eventName, runtime, event, resultWithWarning);
  state.efficiency.last_results ??= {};
  state.efficiency.last_results[scopeId] = normalizeEfficiencyResult(resultWithWarning);
  incrementHealth(state, 'efficiency_events_seen');
  if (resultWithEvidence.classification === 'watch') incrementHealth(state, 'efficiency_watch_receipts');
  if (resultWithEvidence.classification === 'likely_loop') incrementHealth(state, 'likely_loop_receipts');
  if (resultWithEvidence.classification === 'runaway_risk') incrementHealth(state, 'runaway_risk_receipts');
  if (resultWithEvidence.classification === 'intentional_recurring_activity') incrementHealth(state, 'intentional_recurring_receipts');
  return resultWithWarning;
}

function deferredReplayInput(record) {
  const event = record?.event ?? {};
  return {
    ...(record?.host_version ? { host_version: record.host_version } : {}),
    session_id: record?.session,
    ...(record?.turn_id ? { turn_id: record.turn_id } : {}),
    ...(event.agent_id ? { agent_id: event.agent_id } : {}),
    ...(event.source_id ? { source_id: event.source_id } : {}),
    ...(event.tool_use_id ? { tool_use_id: event.tool_use_id } : {}),
    ...(event.agent_type ? { agent_type: event.agent_type } : {}),
    ...(event.tool_name ? { tool_name: event.tool_name } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.error_category ? { error_category: event.error_category } : {}),
    ...(event.stop_hook_active !== undefined ? { stop_hook_active: event.stop_hook_active } : {}),
    ...(event.final !== undefined ? { final: event.final } : {}),
    ...(event.trigger ? { trigger: event.trigger } : {}),
    ...(event.background === true ? { background: true } : {}),
    ...(event.scheduled === true ? { scheduled: true } : {}),
    ...(event.recurring === true ? { recurring: true } : {}),
    ...(event.structural_progress !== undefined ? { structural_progress: event.structural_progress } : {}),
    ...(event.total_tokens !== undefined ? { total_tokens: event.total_tokens } : {}),
    ...(event.total_duration_ms !== undefined ? { total_duration_ms: event.total_duration_ms } : {}),
    ...(event.total_tool_use_count !== undefined ? { total_tool_use_count: event.total_tool_use_count } : {}),
    ...(event.resolved_model ? { resolved_model: event.resolved_model } : {}),
  };
}

function recordDeferredEfficiencyEvent(state, record, runtime) {
  const event = record?.event;
  if (!event || event.host !== (runtime === 'claude' ? 'claude' : 'codex')) {
    incrementHealth(state, 'efficiency_events_dropped');
    return null;
  }
  const eventName = event.event_type;
  const input = deferredReplayInput(record);
  const acceptance = record?.acceptance?.enabled === true
    ? { enabled: true, scenario: record.acceptance.scenario ?? 'extended-events' }
    : { enabled: false, scenario: 'extended-events' };
  observeEfficiencyCapability(state, input, event, eventName, runtime, acceptance, {
    fields: record.fields,
    host_version: record.host_version,
  });
  recordAcceptanceObservation(state, input, eventName, runtime, event, acceptance);
  const sessionRecord = recordSanitizedSessionEvent(state.advisor, {
    host: runtime === 'claude' ? 'claude' : 'codex',
    session_hash: record.session,
    event_type: eventName,
    timestamp: event.timestamp,
  });
  if (!sessionRecord || sessionRecord.generation !== record.session_generation) {
    incrementHealth(state, 'late_events_after_close');
    return { late_event: true };
  }
  if (sessionRecord.closed_at !== null && sessionRecord.closed_at !== undefined) {
    incrementHealth(state, 'late_events_after_close');
    return { late_event: true };
  }
  if (runtime === 'claude') {
    invalidateClaudeFinalSnapshotsBySafeContext(
      state,
      record.session,
      record.session_generation,
      record.claude_final_invalidation,
    );
  }
  return recordScopedEfficiencyEvent(state, input, eventName, runtime, event, {
    session: record.session,
    generation: record.session_generation,
    scope_id: record.scope_id,
  });
}

function drainDeferredHotEvents(stateDir, state, runtime) {
  const journal = readHotEvents(stateDir);
  if (!Number.isSafeInteger(journal.epoch) || journal.epoch <= 0) {
    if (journal.dropped > 0) {
      incrementHealth(state, 'efficiency_events_dropped', journal.dropped);
      incrementHealth(state, 'retention_drops', journal.dropped);
    }
    return { should_reset: journal.recovered === true };
  }
  if (journal.events.length === 0 && journal.dropped === 0) return { should_reset: false };
  state.hot_events = persistedHotEventState(state.hot_events);
  const alreadyDrained = state.hot_events.last_drained_epoch >= journal.epoch;
  if (journal.dropped > 0) {
    incrementHealth(state, 'efficiency_events_dropped', journal.dropped);
    incrementHealth(state, 'retention_drops', journal.dropped);
    if (journal.retention_drops > 0) incrementHealth(state, 'efficiency_retention_drops', journal.retention_drops);
  }
  if (!alreadyDrained) {
    if (state[RECOVERED_STATE]) {
      incrementHealth(state, 'efficiency_events_dropped', journal.events.length);
      incrementHealth(state, 'retention_drops', journal.events.length);
    } else {
      for (const record of journal.events) recordDeferredEfficiencyEvent(state, record, runtime);
    }
    state.hot_events.last_drained_epoch = journal.epoch;
  }
  return { should_reset: true, epoch: journal.epoch };
}

function recordOptimizationObservation(state, input, eventName, runtime, event, efficiency) {
  if (!state || !state.optimization || !['Stop', 'StopFailure'].includes(eventName)) return;
  if (event?.stop_hook_active !== true) return;
  state.optimization.goal_hygiene ??= {};
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const gates = Object.values(state.optimization.manual_gates ?? {})
    .filter((gate) => gate?.status === 'open' && (gate.host === host || gate.host === 'unknown'))
    .slice(-8);
  for (const gate of gates) {
    const key = `${host}:${gate.gate_id}`;
    const prior = state.optimization.goal_hygiene?.[key] ?? {};
    const hygiene = recordGoalContinuation(state.optimization.goal_hygiene, {
      host,
      gate_id: gate.gate_id,
      gate,
      stop_continuation_count: event.stop_hook_active === true ? 1 : 0,
      structural_progress_occurred: event.structural_progress === true,
      structural_progress: event.structural_progress === true ? 1 : 0,
      usage_quality: 'unavailable',
      previous_evidence_revision: prior.last_evidence_revision ?? gate.evidence_revision,
      now: event.timestamp,
    });
    const previousDecision = state.optimization.shadow_policy?.at(-1);
    const decisionId = hashId(`${host}:${gate.gate_id}:${gate.evidence_revision}:${hygiene.continuation_count}`);
    const usageQuality = Number.isSafeInteger(efficiency?.affected_exact_tokens)
      ? 'exact'
      : Number.isSafeInteger(efficiency?.affected_partial_lower_bound_tokens)
        ? 'partial'
        : 'unavailable';
    const budget = state.usage?.config?.local_budgets?.max_tokens_per_session;
    const sessionHash = sessionIdentity(runtime, input.session_id);
    const totalsKey = sessionHash ? sessionTotalsKey(sessionHash, sessionGeneration(state, input, runtime)) : null;
    const priorSessionTokens = totalsKey && Number.isSafeInteger(state.usage?.session_totals?.[totalsKey]?.tokens)
      ? state.usage.session_totals[totalsKey].tokens
      : null;
    const currentTokens = Number.isSafeInteger(efficiency?.affected_exact_tokens)
      ? efficiency.affected_exact_tokens
      : Number.isSafeInteger(efficiency?.affected_partial_lower_bound_tokens)
        ? efficiency.affected_partial_lower_bound_tokens
        : null;
    const shadow = evaluateShadowPolicy({
      decision_id: decisionId,
      host,
      manual_gate: gate,
      same_evidence_revision: hygiene.same_evidence_revision,
      manual_gate_continuations: hygiene.continuation_count,
      stop_continuation_count: hygiene.continuation_count,
      structural_progress: hygiene.structural_progress,
      capability_quality: efficiency?.provenance?.evidence_quality ?? 'insufficient_evidence',
      quality: usageQuality,
      session_budget: budget,
      session_tokens: priorSessionTokens !== null && currentTokens !== null
        ? saturatingNonNegativeSum(priorSessionTokens, currentTokens)
        : priorSessionTokens,
      duplicate: previousDecision?.decision_id === decisionId,
      created_at: event.timestamp,
    });
    state.optimization.shadow_policy ??= [];
    if (!state.optimization.shadow_policy.some((entry) => entry?.decision_id === decisionId)) {
      state.optimization.shadow_policy.push(shadow);
      incrementHealth(state, 'shadow_decisions');
      if (shadow.suppressed_duplicate) incrementHealth(state, 'shadow_duplicate_suppressions');
    }
    if (hygiene.reason_codes.length) incrementHealth(state, 'manual_gate_continuations');
    if (hygiene.classification !== 'normal') incrementHealth(state, 'goal_hygiene_warnings');
    state.optimization.goal_hygiene[key] = {
      ...(state.optimization.goal_hygiene[key] ?? {}),
      continuation_count: hygiene.continuation_count,
      last_evidence_revision: hygiene.evidence_revision,
      structural_progress: hygiene.structural_progress,
      updated_at: event.timestamp,
    };
  }
}

function warningText(efficiency, usageLayers, thresholdWarnings = []) {
  const lines = [];
  if (efficiency?.warning_emitted) {
    const reason = efficiency.reason_codes?.[0] ?? 'structural_no_progress';
    const tokens = efficiency.affected_exact_tokens ?? usageLayers?.observed?.total_tokens;
    const tokenLabel = Number.isSafeInteger(tokens) ? `${tokens} affected-turn tokens` : 'affected usage unmeasured';
    lines.push(`SomesToken · efficiency ${humanLabel(efficiency.classification)} · ${humanLabel(reason)} · ${tokenLabel} · savings unmeasured · Next: review the affected turn before changing the workflow.`);
  }
  const prioritized = thresholdWarnings.find((warning) => ['local_budget_exceeded', 'plan_usage_100', 'plan_usage_exhausted'].includes(warning.reason_code));
  const displayedThresholds = [...thresholdWarnings.slice(0, 3), ...(prioritized ? [prioritized] : [])]
    .filter((warning, index, entries) => entries.findIndex((entry) => entry.reason_code === warning.reason_code) === index)
    .slice(0, 4);
  for (const warning of displayedThresholds) {
    const label = warning.reason_code?.startsWith('local_budget_') ? 'local budget' : 'plan usage';
    const threshold = Number.isFinite(warning.threshold_percent) ? `${warning.threshold_percent}% threshold ${warning.reason_code.endsWith('exceeded')||warning.reason_code.endsWith('exhausted')?'exceeded':'reached'}` : humanLabel(warning.reason_code);
    lines.push(`SomesToken · ${label} · ${threshold} · report-only · Next: review usage and your ${label==='local budget'?'local budget':'account quota'}.`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Emit the bounded workflow candidate only after the advisor's observation
 * gate is met. The record is intentionally smaller than the public report so
 * it can be used solely for cooldown/deduplication without retaining model
 * content, prompts, or host identifiers.
 */
function workflowAdvisorMessage(state, advisor) {
  const analytics = advisor?.workflow_advisor;
  const evidence = analytics?.evidence;
  if (!analytics
    || analytics.workflow_advisor_schema_version !== WORKFLOW_ADVISOR_SCHEMA_VERSION
    || analytics.status !== 'exact'
    || analytics.eligibility !== 'eligible'
    || evidence?.receipt_quality !== 'exact'
    || evidence?.telemetry_state !== 'received'
    || evidence?.structural_metrics_quality !== 'exact') return null;
  state.advisor ??= createAdvisorState();
  state.advisor.workflow_history ??= [];
  const notice = workflowAdvisorNotice(analytics, state.advisor.workflow_history, timestamp());
  if (!notice) {
    incrementHealth(state, 'workflow_recommendations_suppressed');
    return null;
  }
  state.advisor.workflow_history.push(notice.record);
  trimAdvisorState(state.advisor);
  incrementHealth(state, 'workflow_recommendations_generated');
  return notice.text;
}

function attachScopeChildren(state, input, turn, runtime = 'codex') {
  const generation = sessionGeneration(state, input, runtime);
  const targetScopeId = scopeIdentity(runtime, input.session_id, input.turn_id, generation);
  const scope = targetScopeId ? state.scopes[targetScopeId] : undefined;
  const sessionHash = sessionIdentity(runtime, input.session_id);
  if (!sessionHash) return;
  const sessionAgents = Object.entries(state.agent_scopes).filter(([, link]) => (
    link.session === sessionHash
    && (Number.isSafeInteger(link.session_generation) ? link.session_generation : 0) === generation
    && link.status === 'pending'
    && link.open === true
  ));
  if (!targetScopeId) {
    turn.overflow_count = Math.min(MAX_AGENTS_PER_TURN, (turn.overflow_count ?? 0) + sessionAgents.length);
    return;
  }
  const openAgents = sessionAgents.filter(([, link]) => link.source_scope === targetScopeId);
  // A lifecycle link that does not match this safe main-turn scope is not
  // attachable. Transcript paths are not an identity fallback; keep the
  // uncertainty explicit instead of mixing it into an unrelated parent.
  // A lifecycle-owned child from another transcript scope remains pending in
  // that scope. It is not an overflow source for this parent: treating it as
  // one would make unrelated exact turns look partial without any token link.
  const target = scope ?? ensureScope(state, targetScopeId);
  // Keep the most recent parent boundary even when it has no child yet. Hook
  // commands for a single host turn may reach us out of order; a same-turn
  // SubagentStart after Stop must downgrade that parent instead of silently
  // creating an unrelated next-generation scope.
  if (target.closed && target.parent_turn !== turn.turn_id) {
    target.closed = false;
    target.generation += 1;
    target.overflow_count = 0;
    delete target.parent_turn;
  }
  turn.overflow_count = Math.max(turn.overflow_count ?? 0, target.overflow_count ?? 0);
  if (openAgents.length > 0) {
    target.closed = false;
    for (const [agentHash, link] of openAgents.slice(0, MAX_AGENTS_PER_TURN)) {
      target.generation = Math.max(target.generation, link.generation ?? 0);
      if (link.status === 'pending' && !target.completed[agentHash]) {
        target.active[agentHash] ??= {
          agent_id: agentHash,
          child_turn: link.child_turn,
          generation: link.generation ?? target.generation,
          session_generation: link.session_generation ?? generation,
          updated_at: timestamp(),
        };
      }
      state.agent_scopes[agentHash] = { ...link, open: false, updated_at: timestamp() };
    }
  }
  if (target.closed) return;
  for (const [agentHash, active] of Object.entries(target.active).slice(0, MAX_AGENTS_PER_TURN)) {
    turn.subagents[agentHash] ??= {
      agent_id: agentHash,
      status: 'pending',
      child_turn: active.child_turn,
      generation: active.generation,
      ...(Number.isSafeInteger(active.session_generation) ? { session_generation: active.session_generation } : {}),
      ...(active.metadata ? { metadata: active.metadata } : {}),
      updated_at: timestamp(),
    };
    // Some hosts reuse the parent turn identifier for child lifecycle events.
    // Preserve an already-created pending entry, but still attach the safe
    // lifecycle-owned child turn hash required for later scoped reconciliation.
    turn.subagents[agentHash].child_turn ??= active.child_turn;
    turn.subagents[agentHash].generation ??= active.generation;
    turn.subagents[agentHash].session_generation ??= active.session_generation;
  }
  for (const [agentHash, completed] of Object.entries(target.completed).slice(0, MAX_AGENTS_PER_TURN)) {
    if (completed.generation !== target.generation) continue;
    turn.subagents[agentHash] = {
      agent_id: agentHash,
      status: completed.status,
      ambiguous: completed.ambiguous === true,
      child_turn: completed.child_turn,
      generation: completed.generation,
      ...(Number.isSafeInteger(completed.session_generation) ? { session_generation: completed.session_generation } : {}),
      ...(completed.usage ? { usage: completed.usage } : {}),
      ...(SUBAGENT_USAGE_SOURCES.has(completed.usage_source) ? { usage_source: completed.usage_source } : {}),
      ...(completed.metadata ? { metadata: completed.metadata } : {}),
      ponytail: persistedPonytail(completed.ponytail),
      updated_at: completed.updated_at,
    };
    delete target.completed[agentHash];
  }
  target.parent_turn = turn.turn_id;
  target.closed = true;
  target.updated_at = timestamp();
}

function metadataSummary(turn, ponytailMode) {
  const modelLabel = (model) => {
    return String(model);
  };
  const main = turn.main?.metadata;
  const entries = Object.values(turn.subagents ?? {}).filter((entry) => entry?.metadata?.model && entry?.metadata?.reasoning_effort);
  const groups = new Map();
  for (const entry of entries) {
    const key = `${modelLabel(entry.metadata.model)}/${entry.metadata.reasoning_effort}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const parts = [];
  const mainKey = main?.model && main.reasoning_effort ? `${modelLabel(main.model)}/${main.reasoning_effort}` : undefined;
  if (mainKey) parts.push(`main ${mainKey}`);
  const effectiveTier = main?.service_tier;
  const requestedTier = main?.requested_service_tier;
  if (effectiveTier === 'priority' || effectiveTier === 'fast') parts.push('Fast');
  else if (effectiveTier === 'default' && (requestedTier === 'fast' || requestedTier === 'priority')) parts.push('Fast→Standard');
  else if (effectiveTier === 'default') parts.push('Standard');
  const sub = [...groups.entries()].filter(([key]) => key !== mainKey);
  if (sub.length) parts.push(`sub ${sub.map(([key, count]) => `${key}×${count}`).join(',')}`);
  if (ponytailMode) parts.push(`Ponytail ${ponytailMode}`);
  return safeReceiptMetadataSummary(parts.join(' · '));
}

function aggregateMetadataStatus(turn) {
  const entries = [turn.main, ...Object.values(turn.subagents ?? {})].filter(Boolean);
  if (!entries.length || entries.every((entry) => !entry.metadata || entry.metadata.status === 'unknown')) return 'unknown';
  if (entries.some((entry) => !entry.metadata || entry.metadata.status !== 'observed')) return 'partial';
  return 'observed';
}

function aggregateMetadataSource(turn) {
  return [...new Set([turn.main, ...Object.values(turn.subagents ?? {})]
    .map((entry) => entry?.metadata?.source)
    .filter(Boolean)
    .flatMap((source) => source.split('+')))].join('+') || undefined;
}

function aggregateMetadataConfidence(turn) {
  const confidences = [turn.main, ...Object.values(turn.subagents ?? {})]
    .map((entry) => entry?.metadata?.confidence)
    .filter(Boolean);
  if (!confidences.length || confidences.every((value) => value === 'low')) return 'low';
  if (confidences.some((value) => value === 'medium')) return 'medium';
  return 'high';
}

function aggregatePonytail(turn) {
  const entries = [turn.main, ...Object.values(turn.subagents ?? {})].map((entry) => entry?.ponytail).filter(Boolean);
  const confirmed = entries.find((entry) => ['confirmed-marker', 'off-confirmed'].includes(entry.status) && entry.mode);
  if (confirmed) return { ...persistedPonytail(confirmed), status: confirmed.status };
  const configured = entries.find((entry) => entry.status === 'configured-default' && entry.mode);
  if (configured) return { ...persistedPonytail(configured), status: 'configured-default' };
  return { status: 'unknown', reason: PONYTAIL_UNKNOWN_REASON, coverage_count: 0 };
}

function reconcilePendingReceipt(state, turn, receipt, input, runtime, structuredUsage, env, options = {}) {
  const previousReceipt = { ...receipt };
  const previousUsageLayers = receipt.usage_layers;
  const reconciliationSource = TELEMETRY_SOURCES.has(options.source) ? options.source : 'structured_hook';
  const mainAmbiguous = options.ambiguous === true || structuredUsage.quality === 'partial' || structuredUsage.consistent === false;
  const subagents = Object.values(turn.subagents).slice(0, MAX_AGENTS_PER_TURN).map((entry) => ({
    valid: entry.status === 'completed' && Boolean(entry.usage),
    ambiguous: Boolean(entry.ambiguous),
    usage: entry.usage,
  }));
  const main = {
    valid: true,
    ambiguous: mainAmbiguous,
    delta: structuredUsage,
  };
  const validUsages = [structuredUsage, ...subagents.filter((entry) => entry.valid).map((entry) => entry.usage)];
  const summed = sumUsage(validUsages);
  const ambiguous = main.ambiguous || subagents.some((entry) => entry.ambiguous) || turn.overflow_count > 0 || summed.consistent === false;
  const status = classifyReceipt({ main, subagents, ambiguous });
  const model = safeModel(input.model) ?? turn.main?.metadata?.model;
  const builtUsage = buildReceiptUsageLayers({ runtime, status, summed, model, input, env });
  const planComparison = planComparisonForReceipt(state, runtime, status, summed);
  const expectedSources = 1 + Object.keys(turn.subagents).length + (turn.overflow_count ?? 0);
  const resolvedSources = 1 + subagents.filter((entry) => entry.valid).length;
  const unavailableSources = Math.max(0, expectedSources - resolvedSources);
  const metadata = mergeRuntimeMetadata(hookMetadata(input, 'main'), turn.main?.metadata);
  turn.main = {
    ...(turn.main ?? {}),
    valid: true,
    ambiguous: main.ambiguous,
    reason: undefined,
    usage: tokenFields(structuredUsage),
    metadata,
    metadata_status: metadata.status,
    metadata_source: metadata.source,
  };
  Object.assign(receipt, tokenFields(summed), {
    status,
    accounting_status: status,
    reason: undefined,
    agents: expectedSources,
    expected_sources: expectedSources,
    resolved_sources: resolvedSources,
    unavailable_sources: unavailableSources,
    overflow_sources: turn.overflow_count ?? 0,
    workflow_context: workflowContextForReceipt({ metadata }, state.usage?.config?.workflow_advisor),
    telemetry_reconciliation: telemetryReconciliation(reconciliationSource, (receipt.telemetry_reconciliation?.attempts ?? 1) + 1),
    stop_failure_category: undefined,
    ...(builtUsage.usageLayers ? { usage_layers: builtUsage.usageLayers, usage_coverage: builtUsage.coverage } : {}),
    ...(planComparison ? { plan_comparison: planComparison } : {}),
  });
  turn.receipt = receipt;
  turn.updated_at = timestamp();
  annotateUsageOutlier(state, receipt);
  recordUsageSnapshot(state, runtime, builtUsage.usageLayers, receipt, {
    reconcile: true,
    previousUsageLayers,
  });
  if (state.usage?.config?.local_budgets && typeof state.usage.config.local_budgets === 'object') {
    updateSessionUsageTotals(state, receipt, builtUsage.usageLayers, { previousReceipt, previousUsageLayers });
  }
  const advisor = advisorReport(state, state.receipts, { last: MAX_TURNS });
  const workflowNotice = workflowAdvisorMessage(state, advisor);
  const systemMessage = [formatReceipt(receipt), workflowNotice].filter(Boolean).join('\n');
  return { systemMessage };
}

function stopFailureCategory(input) {
  const category = input?.error_category ?? input?.error;
  if (ERROR_CATEGORIES.has(category)) return category;
  return typeof category === 'string' && category.trim() ? 'unknown' : undefined;
}

function responseForStopFailure(state, input, runtime = 'codex', efficiency = null) {
  const snapshot = readSnapshots(input.transcript_path, runtime);
  const turnHash = stopTurnIdentity(state, input, snapshot, runtime);
  const turn = ensureTurn(state, turnHash);
  if (turn.receipt) {
    incrementHealth(state, 'duplicate_hooks');
    incrementHealth(state, 'duplicate_events');
    return {};
  }

  attachScopeChildren(state, input, turn, runtime);
  const subagents = Object.values(turn.subagents).slice(0, MAX_AGENTS_PER_TURN);
  const expectedSources = 1 + subagents.length + (turn.overflow_count ?? 0);
  const resolvedSources = subagents.filter((entry) => entry.status === 'completed' && Boolean(entry.usage)).length;
  const unavailableSources = Math.max(0, expectedSources - resolvedSources);
  const metadata = mergeRuntimeMetadata(hookMetadata(input, 'main'), turn.main?.metadata);
  turn.main = {
    ...(turn.main ?? {}),
    valid: false,
    ambiguous: true,
    reason: 'stop_failure',
    metadata,
    metadata_status: metadata.status,
    metadata_source: metadata.source,
  };
  const category = stopFailureCategory(input);
  const metadataSource = aggregateMetadataSource(turn);
  const generation = sessionGeneration(state, input, runtime);
  const receipt = {
    schema_version: SCHEMA_VERSION,
    turn_id: turnHash,
    ...(sessionIdentity(runtime, input.session_id) ? { session: sessionIdentity(runtime, input.session_id) } : {}),
    ...(generation > 0 ? { session_generation: generation } : {}),
    status: 'unavailable',
    agents: expectedSources,
    expected_sources: expectedSources,
    resolved_sources: resolvedSources,
    unavailable_sources: unavailableSources,
    overflow_sources: turn.overflow_count ?? 0,
    accounting_status: 'unavailable',
    metadata_status: aggregateMetadataStatus(turn),
    metadata_confidence: aggregateMetadataConfidence(turn),
    ...(metadataSource ? { metadata_source: metadataSource } : {}),
    metadata: turn.main.metadata,
    workflow_context: workflowContextForReceipt({ metadata: turn.main.metadata }, state.usage?.config?.workflow_advisor),
    usage_coverage: 'unavailable',
    telemetry_reconciliation: telemetryReconciliation('none', 1, 'stop_failure_without_usage'),
    ...(category ? { stop_failure_category: category } : {}),
    efficiency: efficiency ? { ...efficiency, avoidable_usage: 'unmeasured' } : { classification: 'normal', reason_codes: [], evidence_counts: {}, avoidable_usage: 'unmeasured' },
    ponytail: aggregatePonytail(turn),
    savings: { status: 'unmeasured' },
    reason: 'stop_failure',
    created_at: timestamp(),
  };
  turn.receipt = receipt;
  turn.updated_at = timestamp();
  state.receipts.push(receipt);
  incrementHealth(state, 'unavailable_receipts');
  incrementHealth(state, 'unresolved_sources', unavailableSources);
  trimAdvisorState(state.advisor);
  return {};
}

function refreshActiveStopEfficiency(receipt, efficiency) {
  if (!receipt || !efficiency || efficiency.warning_emitted !== true) return null;
  const updated = normalizeEfficiencyResult({
    ...efficiency,
    affected_exact_tokens: efficiency.affected_exact_tokens ?? (receipt.status === 'exact' ? receipt.total_tokens : undefined),
    affected_partial_lower_bound_tokens: efficiency.affected_partial_lower_bound_tokens
      ?? (receipt.status === 'partial' ? receipt.total_tokens : undefined),
    affected_calculated_credits: efficiency.affected_calculated_credits
      ?? receipt.usage_layers?.calculated?.calculated_codex_credits,
    avoidable_usage: 'unmeasured',
  });
  receipt.efficiency = updated;
  return { ...updated, warning_emitted: true };
}

function responseForStop(state, input, runtime = 'codex', efficiency = null, env = process.env, thresholdWarnings = []) {
  const structuredUsage = structuredPostTurnUsage(input, runtime);
  // Complete host counters with an explicit turn/session binding need no
  // transcript reread. Ambiguous/partial deliveries retain the old fallback.
  const preferredStructured=structuredUsage?.quality==='exact'&&safeOpaqueHostIdentifier(input.session_id)&&safeOpaqueHostIdentifier(input.turn_id)?structuredUsage:null;
  const snapshot = preferredStructured?{unreadable:true,truncated:false,parsed:parseTokenSnapshots('')}:readSnapshots(input.transcript_path, runtime);
  const turnHash = stopTurnIdentity(state, input, snapshot, runtime);
  const turn = ensureTurn(state, turnHash);
  if (turn.receipt) {
    if (structuredUsage && turn.receipt.telemetry_reconciliation?.state === 'pending_post_turn') {
      const receipt = state.receipts.find((entry) => entry?.turn_id === turnHash) ?? turn.receipt;
      return reconcilePendingReceipt(state, turn, receipt, input, runtime, structuredUsage, env);
    }
    // An explicitly active Stop is a host continuation signal, not a replay of
    // the completed receipt. Keep one receipt, but surface the first throttled
    // structural warning against that already-accounted turn.
    const receipt = state.receipts.find((entry) => entry?.turn_id === turnHash) ?? turn.receipt;
    const continuedEfficiency = input?.stop_hook_active === true
      ? refreshActiveStopEfficiency(receipt, efficiency)
      : null;
    if (continuedEfficiency) {
      turn.receipt = receipt;
      const systemMessage = warningText(continuedEfficiency, receipt?.usage_layers);
      if (systemMessage) return { systemMessage };
    }
    incrementHealth(state, 'duplicate_hooks');
    incrementHealth(state, 'duplicate_events');
    return {};
  }
  // Claude's final display batch is delivered before Stop. Prefer a current
  // readable transcript, but otherwise consume one matching staged numeric
  // snapshot. The staged route is deliberately partial because the display
  // lifecycle alone cannot prove that no later model work occurred.
  const stagedSnapshot = runtime === 'claude' ? takeClaudeFinalSnapshot(state, input, turnHash) : null;
  const mainSnapshot = !snapshot.unreadable && snapshot.parsed?.latest
    ? snapshot
    : stagedSnapshot ?? snapshot;
  attachScopeChildren(state, input, turn, runtime);

  const generation = sessionGeneration(state, input, runtime);
  const mainSourceId = sourceIdentity(runtime, input.session_id, 'main', generation);
  const mainKey = threadIdentity('main', mainSourceId);
  const main = preferredStructured?{valid:false,ambiguous:false,metadata:hookMetadata(input,'main')}:mainKey && mainSourceId
    ? updateThread(state, mainKey, input.transcript_path, mainSourceId, mainSnapshot, { runtime, session_id: input.session_id, turn_id:input.turn_id })
    : { valid: false, ambiguous: true, reason: 'source-mismatch' };
  if(preferredStructured&&mainKey&&mainSourceId){
    const prior=state.threads[mainKey];
    // Per-turn usage is not a cumulative transcript baseline. A later prompt
    // hook can rebaseline; a missing prompt must never bill prior usage again.
    state.threads[mainKey]={schema_version:SCHEMA_VERSION,thread_id:mainKey,source_id:mainSourceId,
      usage:prior?.usage??tokenFields(preferredStructured),metadata:hookMetadata(input,'main'),
      accounting_basis:'structured_hook_v1',compaction_count:prior?.compaction_count??0,updated_at:timestamp()};
  }
  const structuredMain = !main.valid && structuredUsage ? structuredUsage : null;
  const mainUsage = main.valid ? main.delta : structuredMain;
  const mainValid = main.valid || Boolean(structuredMain);
  const mainAmbiguous = main.valid
    ? main.ambiguous || mainSnapshot.staged_final_message === true
    : structuredMain?.quality === 'partial';
  const mainMetadata = mergeRuntimeMetadata(hookMetadata(input, 'main'), main.metadata, turn.main?.metadata);
  turn.main = {
    valid: mainValid,
    ambiguous: mainAmbiguous,
    reason: mainValid ? undefined : main.reason,
    ...(mainUsage ? { usage: tokenFields(mainUsage) } : {}),
    ...(mainSourceId ? { source_id: mainSourceId } : {}),
    model: safeModel(input.model),
    metadata: mainMetadata,
    metadata_status: mainMetadata.status,
    metadata_source: mainMetadata.source,
    ponytail: main.ponytail,
  };

  const subagents = Object.values(turn.subagents).slice(0, MAX_AGENTS_PER_TURN).map((entry) => ({
    valid: entry.status === 'completed' && Boolean(entry.usage),
    ambiguous: Boolean(entry.ambiguous),
    usage: entry.usage,
  }));
  const validUsages = [mainUsage, ...subagents.filter((entry) => entry.valid).map((entry) => entry.usage)];
  const summed = sumUsage(validUsages);
  const ambiguous = Boolean(mainAmbiguous) || subagents.some((entry) => entry.ambiguous) || turn.overflow_count > 0 || summed.consistent === false;
  const status = classifyReceipt({ main: { valid: mainValid }, subagents, ambiguous });
  const expectedSources = 1 + Object.keys(turn.subagents).length + (turn.overflow_count ?? 0);
  const resolvedSources = (mainValid ? 1 : 0) + subagents.filter((entry) => entry.valid).length;
  const unavailableSources = Math.max(0, expectedSources - resolvedSources);
  const ponytailMode = ['confirmed-marker', 'off-confirmed'].includes(turn.main?.ponytail?.status)
    ? turn.main.ponytail.mode : undefined;
  const metadataStatus = aggregateMetadataStatus(turn);
  const metadataSource = aggregateMetadataSource(turn);
  const metadataConfidence = aggregateMetadataConfidence(turn);
  const ponytail = aggregatePonytail(turn);
  const model = safeModel(input.model) ?? turn.main?.metadata?.model;
  const builtUsage = status === 'unavailable' ? { usageLayers: null, coverage: 'unavailable', authMode: runtime === 'claude' ? detectClaudeAuthMode(input, env) : 'codex' } : buildReceiptUsageLayers({ runtime, status, summed, model, input, env });
  const { usageLayers, coverage, authMode } = builtUsage;
  const planComparison = planComparisonForReceipt(state, runtime, status, summed);
  const receiptTokenFields = status === 'unavailable' ? {} : tokenFields(summed);
  if (planComparison) {
    incrementHealth(state, 'plan_comparisons');
    const outcome = planComparisonHealthKey(planComparison);
    if (outcome) incrementHealth(state, outcome);
  }
  const receipt = {
    schema_version: SCHEMA_VERSION,
    turn_id: turnHash,
    ...(sessionIdentity(runtime, input.session_id) ? { session: sessionIdentity(runtime, input.session_id) } : {}),
    ...(generation > 0 ? { session_generation: generation } : {}),
    status,
    ...receiptTokenFields,
    agents: expectedSources,
    expected_sources: expectedSources,
    resolved_sources: resolvedSources,
    unavailable_sources: unavailableSources,
    overflow_sources: turn.overflow_count ?? 0,
    accounting_status: status,
    metadata_status: metadataStatus,
    metadata_confidence: metadataConfidence,
    ...(metadataSource ? { metadata_source: metadataSource } : {}),
    metadata: turn.main?.metadata,
    workflow_context: workflowContextForReceipt({ metadata: turn.main?.metadata }, state.usage?.config?.workflow_advisor),
    ...(usageLayers ? { usage_layers: usageLayers } : {}),
    usage_coverage: coverage,
    telemetry_reconciliation: main.reason === 'identity-rebaseline'
      ? { state: 'unavailable', source: 'none', attempts: 1, outcome: 'identity_rebaseline' }
      : telemetryReconciliation(
        structuredMain ? 'structured_hook' : main.valid ? 'transcript' : 'none',
        1,
        mainValid ? 'received' : telemetryOutcomeForReason(main.reason),
      ),
    ...(planComparison ? { plan_comparison: planComparison } : {}),
    ...(runtime === 'claude' && authMode === 'subscription' ? { subscription_usage: 'unavailable', account_quota: 'unavailable' } : {}),
    efficiency: efficiency ? {
      ...efficiency,
      affected_exact_tokens: efficiency.affected_exact_tokens ?? (status === 'exact' ? summed.total_tokens : undefined),
      affected_partial_lower_bound_tokens: efficiency.affected_partial_lower_bound_tokens ?? (status === 'partial' ? summed.total_tokens : undefined),
      affected_calculated_credits: usageLayers?.calculated?.calculated_codex_credits,
      avoidable_usage: 'unmeasured',
    } : { classification: 'normal', reason_codes: [], evidence_counts: {}, avoidable_usage: 'unmeasured' },
    ponytail,
    savings: { status: 'unmeasured' },
    ...(metadataSummary(turn, ponytailMode) ? { metadata_summary: metadataSummary(turn, ponytailMode) } : {}),
    ...(!mainValid && main.reason ? { reason: main.reason } : {}),
    created_at: timestamp(),
  };
  if (status === 'partial') incrementHealth(state, 'partial_receipts');
  if (status === 'unavailable') incrementHealth(state, 'unavailable_receipts');
  incrementHealth(state, 'unresolved_sources', unavailableSources);
  turn.receipt = receipt;
  turn.updated_at = timestamp();
  annotateUsageOutlier(state, receipt);
  state.receipts.push(receipt);
  const advisor = advisorReport(state, state.receipts, { last: MAX_TURNS });
  state.advisor.recommendation_history ??= [];
  if (advisor.recommendations.length) {
    state.advisor.recommendation_history.push(...advisor.recommendations.map((entry) => ({ ...entry, recorded_at: timestamp() })));
    incrementHealth(state, 'recommendations_generated', advisor.recommendations.length);
  } else {
    incrementHealth(state, 'recommendations_suppressed');
  }
  if (advisor.baseline_comparison?.group_key) {
    if (!state.advisor.baselines?.[advisor.baseline_comparison.group_key]) incrementHealth(state, 'baseline_groups_created');
    state.advisor.baselines ??= {};
    state.advisor.baselines[advisor.baseline_comparison.group_key] = {
      quality: advisor.baseline_comparison.quality,
      sample_count: advisor.baseline_comparison.sample_count,
      median: advisor.baseline_comparison.median,
      mad: advisor.baseline_comparison.mad,
      updated_at: timestamp(),
    };
    if (advisor.baseline_comparison.quality !== 'exact') incrementHealth(state, 'comparison_incomparable');
  }
  if (advisor.structural_metrics?.cache_efficiency?.quality === 'unavailable') incrementHealth(state, 'cache_semantics_unavailable');
  trimAdvisorState(state.advisor);
  recordUsageSnapshot(state, runtime, usageLayers, receipt);
  const budgetWarnings = recordLocalBudgetAlerts(state, receipt, usageLayers);
  const warning = warningText(efficiency, usageLayers, [...thresholdWarnings, ...budgetWarnings]);
  const workflowNotice = workflowAdvisorMessage(state, advisor);
  const systemMessage = [formatReceipt(receipt), warning, workflowNotice].filter(Boolean).join('\n');
  return { systemMessage };
}

function processSubagentStart(state, input, runtime = 'codex', env = {}) {
  const generation = sessionGeneration(state, input, runtime);
  const child = childIdentity(input, runtime, generation);
  const childTurnHash = turnIdentity(runtime, input.session_id, input.turn_id, generation, 'subagent', child.sourceId ?? child.agentHash);
  const childTurn = ensureTurn(state, childTurnHash);
  const mainSourceId = sourceIdentity(runtime, input.session_id, 'main', generation);
  const mainTurnHash = turnIdentity(runtime, input.session_id, input.turn_id, generation, 'main', mainSourceId);
  const scopeHash = scopeIdentity(runtime, input.session_id, input.turn_id, generation);
  const scope = scopeHash ? ensureScope(state, scopeHash) : null;
  const agentHash = child.agentHash;
  if (!scope) {
    childTurn.subagents[agentHash] ??= {
      agent_id: agentHash,
      status: 'pending',
      ...(child.sourceId ? { source_id: child.sourceId } : {}),
      metadata: hookMetadata(input, 'worker'),
      updated_at: timestamp(),
    };
    const session = sessionIdentity(runtime, input.session_id);
    if (session) {
      state.agent_scopes[agentHash] ??= {
        agent_id: agentHash,
        session,
        child_turn: childTurnHash,
        ...(child.sourceId ? { child_source_id: child.sourceId } : {}),
        ...(child.lifecycleAgentId ? { lifecycle_agent_id: child.lifecycleAgentId } : {}),
        ...(child.lifecycleTurnId ? { lifecycle_turn_id: child.lifecycleTurnId } : {}),
        generation: 0,
        session_generation: generation,
        status: 'pending',
        open: true,
        updated_at: timestamp(),
      };
    }
    childTurn.updated_at = timestamp();
    return {};
  }
  // Command hooks may be scheduled concurrently. When the host supplies the
  // same safe turn id as the already-closed parent, this is a delayed child
  // start for that parent, not proof of a new generation. Keep the receipt
  // conservative until the child has its own usage boundary.
  const parentTurn = mainTurnHash ? state.turns[mainTurnHash] : null;
  const parentReceipt = scope.closed && scope.parent_turn === mainTurnHash
    ? state.receipts.find((candidate) => candidate?.turn_id === mainTurnHash) ?? parentTurn?.receipt
    : null;
  const lateSameTurnParent = Boolean(parentReceipt
    && parentReceipt.status !== 'unavailable'
    && parentReceipt.session === sessionIdentity(runtime, input.session_id)
    && (Number.isSafeInteger(parentReceipt.session_generation) ? parentReceipt.session_generation : 0) === generation
    && parentTurn?.main?.valid
    && parentTurn.main.usage);
  // Once a main Stop has closed the same safe lifecycle scope, all late
  // child state belongs on that main turn. The child turn remains a bounded
  // source ledger, but must not become a parallel parent or reopen a scope.
  const turn = lateSameTurnParent ? parentTurn : childTurn;
  if (scope.closed && !lateSameTurnParent) {
    scope.closed = false;
    scope.generation += 1;
    scope.overflow_count = 0;
    delete scope.parent_turn;
    // The scope ledger retains prior generation completions only until a
    // parent can consume them. They are never duplicate evidence for a fresh
    // generation, even if the host recycles a safe agent id.
    for (const [id, entry] of Object.entries(scope.active)) {
      if (entry?.generation !== scope.generation) delete scope.active[id];
    }
    for (const [id, entry] of Object.entries(scope.completed)) {
      if (entry?.generation !== scope.generation) delete scope.completed[id];
    }
  }
  const alreadyTracked = scope.active[agentHash]?.generation === scope.generation
    || scope.completed[agentHash]?.generation === scope.generation;
  if (alreadyTracked) {
    incrementHealth(state, 'duplicate_hooks');
    incrementHealth(state, 'duplicate_events');
    return {};
  }
  const trackedAgents = new Set([
    ...Object.entries(scope.active).filter(([, entry]) => entry?.generation === scope.generation).map(([id]) => id),
    ...Object.entries(scope.completed).filter(([, entry]) => entry?.generation === scope.generation).map(([id]) => id),
  ]);
  if (trackedAgents.size >= MAX_AGENTS_PER_TURN) {
    scope.overflow_count = Math.min(MAX_AGENTS_PER_TURN, (scope.overflow_count ?? 0) + 1);
    scope.updated_at = timestamp();
    return {};
  }
  // A SubagentStop can win the hook lock race and record a bounded child
  // delta before its matching Start. Once this Start supplies the same safe
  // session, main-turn, and agent identifiers, move that candidate onto the
  // closed parent. This is lifecycle proof, not transcript-path matching.
  const priorUnlinkedChild = lateSameTurnParent && childTurn !== turn
    ? childTurn.subagents?.[agentHash]
    : null;
  const transferableUnlinkedUsage = priorUnlinkedChild
    && priorUnlinkedChild.status === 'pending'
    && priorUnlinkedChild.reason === 'source-mismatch'
    && priorUnlinkedChild.usage_source === 'transcript'
    && Boolean(priorUnlinkedChild.usage)
    && child.sourceId
    && priorUnlinkedChild.source_id === child.sourceId;
  if (!turn.subagents[agentHash] && transferableUnlinkedUsage) {
    turn.subagents[agentHash] = {
      agent_id: agentHash,
      status: 'pending',
      child_turn: childTurnHash,
      generation: scope.generation,
      session_generation: generation,
      source_id: child.sourceId,
      reason: 'source-mismatch',
      usage: tokenFields(priorUnlinkedChild.usage),
      usage_source: 'transcript',
      updated_at: timestamp(),
    };
    delete childTurn.subagents[agentHash];
    childTurn.updated_at = timestamp();
  }
  turn.subagents[agentHash] ??= {
    agent_id: agentHash,
    status: 'pending',
    child_turn: childTurnHash,
    generation: scope.generation,
    session_generation: generation,
    ...(child.sourceId ? { source_id: child.sourceId } : {}),
    metadata: hookMetadata(input, 'worker'),
    updated_at: timestamp(),
  };
  const childEntry = turn.subagents[agentHash];
  childEntry.child_turn ??= childTurnHash;
  childEntry.generation ??= scope.generation;
  childEntry.session_generation ??= generation;
  const hasPriorUnlinkedUsage = lateSameTurnParent
    && childEntry.status === 'pending'
    && childEntry.reason === 'source-mismatch'
    && childEntry.usage_source === 'transcript'
    && Boolean(childEntry.usage)
    && child.sourceId
    && childEntry.source_id === child.sourceId;
  scope.active[agentHash] = {
    agent_id: agentHash,
    child_turn: childTurnHash,
    ...(child.sourceId ? { child_source_id: child.sourceId } : {}),
    ...(child.lifecycleAgentId ? { lifecycle_agent_id: child.lifecycleAgentId } : {}),
    ...(child.lifecycleTurnId ? { lifecycle_turn_id: child.lifecycleTurnId } : {}),
    generation: scope.generation,
    session_generation: generation,
    updated_at: timestamp(),
    metadata: hookMetadata(input, 'worker'),
  };
  state.agent_scopes[agentHash] = {
    agent_id: agentHash,
    session: sessionIdentity(runtime, input.session_id),
    source_scope: scope.scope_id,
    child_turn: childTurnHash,
    ...(child.sourceId ? { child_source_id: child.sourceId } : {}),
    ...(child.lifecycleAgentId ? { lifecycle_agent_id: child.lifecycleAgentId } : {}),
    ...(child.lifecycleTurnId ? { lifecycle_turn_id: child.lifecycleTurnId } : {}),
    generation: scope.generation,
    session_generation: generation,
    status: 'pending',
    open: true,
    updated_at: timestamp(),
  };
  scope.updated_at = timestamp();
  turn.updated_at = timestamp();
  if (lateSameTurnParent) refreshClosedParentReceipt(state, turn, parentReceipt, input, runtime, env);
  if (hasPriorUnlinkedUsage) {
    // The matching Start now proves that the bounded child delta observed
    // before its lifecycle link belongs to this closed parent. Reconcile the
    // one existing receipt; do not manufacture another child receipt.
    childEntry.status = 'completed';
    childEntry.reason = undefined;
    childEntry.usage = tokenFields(childEntry.usage);
    childEntry.usage_source = 'transcript';
    childEntry.updated_at = timestamp();
    delete scope.active[agentHash];
    scope.completed[agentHash] = {
      agent_id: agentHash,
      child_turn: childTurnHash,
      ...(child.sourceId ? { child_source_id: child.sourceId } : {}),
      generation: scope.generation,
      session_generation: generation,
      status: 'completed',
      ambiguous: childEntry.ambiguous === true,
      usage: tokenFields(childEntry.usage),
      usage_source: 'transcript',
      ...(childEntry.metadata ? { metadata: childEntry.metadata } : {}),
      ponytail: persistedPonytail(childEntry.ponytail),
      updated_at: timestamp(),
    };
    const link = state.agent_scopes[agentHash];
    if (link) state.agent_scopes[agentHash] = { ...link, status: 'completed', updated_at: timestamp() };
    reconcileClosedParentAfterSubagent(state, scope, agentHash, childTurnHash, childEntry, input, runtime, env);
  }
  return {};
}

function processSessionStart(state, input, runtime = 'codex') {
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return {};
  const source = readSnapshots(transcriptPath, runtime);
  if (source.unreadable || !source.parsed.latest) return {};
  const generation = sessionGeneration(state, input, runtime);
  const mainSourceId = sourceIdentity(runtime, input.session_id, 'main', generation);
  const key = threadIdentity('main', mainSourceId);
  if (!key || !mainSourceId) return {};
  const result = updateThread(state, key, transcriptPath, mainSourceId, source, { runtime, session_id: input.session_id });
  if (result.valid || result.current) {
    state.threads[key].metadata = mergeRuntimeMetadata(state.threads[key]?.metadata, hookMetadata(input, 'main'), source.parsed.metadata);
  }
  return {};
}

function pendingClaudeReconciliationResult(outcome) {
  return { reconciled: false, outcome };
}

function reconcilePendingClaudeTranscript(state, input, env = {}) {
  const sessionHash = sessionIdentity('claude', input?.session_id);
  if (!sessionHash || typeof input?.transcript_path !== 'string' || input.transcript_path.length === 0) {
    return { reconciled: false, outcome: 'session_closed_without_usage' };
  }
  const generation = sessionGeneration(state, input, 'claude');

  // A transcript can become readable after Claude fires Stop. Reconcile only
  // one ordinary pending turn, and only when the session boundary proves the
  // transcript belongs to that turn (an existing monotonic baseline or the
  // session's first submitted prompt). Multiple pending turns and failures
  // remain unavailable instead of guessing a cross-turn attribution.
  const pending = state.receipts.filter((entry) => entry?.session === sessionHash
    && (Number.isSafeInteger(entry.session_generation) ? entry.session_generation : 0) === generation
    && entry.telemetry_reconciliation?.state === 'pending_post_turn'
    && entry.reason !== 'stop_failure');
  if (pending.length === 0) return { reconciled: false };
  if (pending.length !== 1) return { reconciled: false, outcome: 'ambiguous_pending_turns' };

  const receipt = pending[0];
  // A reset has already replaced the baseline; it cannot prove this turn's
  // usage on a second read. Only authoritative structured usage may repair it.
  if (['counter-reset','identity-rebaseline'].includes(receipt.reason)) return pendingClaudeReconciliationResult('transcript_ambiguous');
  const turn = state.turns?.[receipt.turn_id];
  const mainSourceId = sourceIdentity('claude', input.session_id, 'main', generation);
  if (!turn || !mainSourceId || turn.main?.source_id !== mainSourceId) {
    return pendingClaudeReconciliationResult('transcript_ambiguous');
  }

  const source = readSnapshots(input.transcript_path, 'claude');
  if (source.unreadable) return pendingClaudeReconciliationResult('transcript_unavailable');
  if (!source.parsed.latest) return pendingClaudeReconciliationResult('token_snapshot_missing');
  const key = threadIdentity('main', mainSourceId);
  const prior = state.threads[key]?.usage;
  const sessionRecord = state.advisor?.sessions?.[sessionKey(input.session_id, 'claude')];
  const promptCount = sessionRecord?.event_counts?.UserPromptSubmit ?? 0;
  if (!prior && promptCount !== 1) {
    return pendingClaudeReconciliationResult('ambiguous_pending_turns');
  }

  const result = updateThread(state, key, input.transcript_path, mainSourceId, source, { runtime: 'claude', session_id: input.session_id });
  if (!result.valid || !result.delta) {
    return pendingClaudeReconciliationResult(telemetryOutcomeForReason(result.reason));
  }
  reconcilePendingReceipt(state, turn, receipt, input, 'claude', result.delta, env, {
    source: 'transcript',
    ambiguous: result.ambiguous,
  });
  return { reconciled: true, outcome: 'received' };
}

function reconcileSession(state, input, runtime = 'codex', env = {}) {
  const sessionHash = sessionIdentity(runtime, input?.session_id);
  if (!sessionHash) return null;
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const generation = sessionGeneration(state, input, runtime);
  const advisorSessionKey = sessionKey(input.session_id, host);
  const alreadyClosed = advisorSessionKey
    ? state.advisor?.sessions?.[advisorSessionKey]?.closed_at !== null && state.advisor?.sessions?.[advisorSessionKey]?.closed_at !== undefined
    : false;
  const reconciliation = runtime === 'claude'
    ? reconcilePendingClaudeTranscript(state, input, env)
    : null;
  finalizePendingTelemetry(state, sessionHash, generation, reconciliation?.outcome);
  const receipts = state.receipts.filter((entry) => entry?.session === sessionHash
    && (Number.isSafeInteger(entry.session_generation) ? entry.session_generation : 0) === generation);
  const pendingFromAgents = Object.values(state.agent_scopes ?? {}).filter((entry) => entry?.session === sessionHash
    && (Number.isSafeInteger(entry.session_generation) ? entry.session_generation : 0) === generation
    && entry.status === 'pending').length;
  const pendingFromReceipts = receipts.reduce((sum, entry) => sum + Math.max(0, entry.unavailable_sources ?? 0), 0);
  const partial = receipts.some((entry) => entry.status === 'partial');
  const unavailable = receipts.some((entry) => entry.status === 'unavailable');
  const closed = closeSession(state.advisor, {
    host,
    session_id: input.session_id,
    pending_sources: Math.min(32, pendingFromAgents + pendingFromReceipts),
    receipt_quality: unavailable ? 'unavailable' : partial ? 'partial' : 'exact',
    receipt_count: receipts.length,
    exact_receipts: receipts.filter((entry) => entry.status === 'exact').length,
    partial_receipts: receipts.filter((entry) => entry.status === 'partial').length,
    unavailable_receipts: receipts.filter((entry) => entry.status === 'unavailable').length,
    now: timestamp(),
  });
  const rebaselineKey = sessionKey(input.session_id, host);
  if (rebaselineKey) delete state.identity_rebaseline?.pending_sessions?.[rebaselineKey];
  if (!alreadyClosed && closed?.closed_at !== null && closed?.closed_at !== undefined) {
    incrementHealth(state, 'session_end_events');
    incrementHealth(state, 'session_reconciliations');
    incrementHealth(state, 'public_sessions_closed');
    if (closed.closure_state === 'closed_partial') incrementHealth(state, 'public_sessions_closed_partial');
    if (closed.closure_state === 'closed_with_pending_sources') incrementHealth(state, 'public_sessions_closed_with_pending');
  }
  return closed;
}

function refreshClosedParentReceipt(state, parentTurn, receipt, input, runtime, env) {
  const previousReceipt = { ...receipt };
  const previousUsageLayers = receipt.usage_layers;
  const subagents = Object.values(parentTurn.subagents).slice(0, MAX_AGENTS_PER_TURN).map((child) => ({
    valid: child.status === 'completed' && Boolean(child.usage),
    ambiguous: child.ambiguous === true,
    usage: child.usage,
  }));
  const summed = sumUsage([parentTurn.main.usage, ...subagents.filter((child) => child.valid).map((child) => child.usage)]);
  const status = classifyReceipt({
    main: { valid: true, ambiguous: parentTurn.main.ambiguous === true },
    subagents,
    ambiguous: parentTurn.main.ambiguous === true || subagents.some((child) => child.ambiguous) || parentTurn.overflow_count > 0 || summed.consistent === false,
  });
  const expectedSources = 1 + Object.keys(parentTurn.subagents).length + (parentTurn.overflow_count ?? 0);
  const resolvedSources = 1 + subagents.filter((child) => child.valid).length;
  const unavailableSources = Math.max(0, expectedSources - resolvedSources);
  const model = receipt.metadata?.model ?? parentTurn.main.metadata?.model;
  const builtUsage = buildReceiptUsageLayers({ runtime, status, summed, model, input, env });
  const planComparison = planComparisonForReceipt(state, runtime, status, summed);
  const efficiency = { ...(receipt.efficiency ?? {}) };
  delete efficiency.affected_exact_tokens;
  delete efficiency.affected_partial_lower_bound_tokens;
  if (status === 'exact') efficiency.affected_exact_tokens = summed.total_tokens;
  if (status === 'partial') efficiency.affected_partial_lower_bound_tokens = summed.total_tokens;
  efficiency.affected_calculated_credits = builtUsage.usageLayers?.calculated?.calculated_codex_credits;
  efficiency.avoidable_usage = 'unmeasured';
  Object.assign(receipt, tokenFields(summed), {
    status,
    accounting_status: status,
    agents: expectedSources,
    expected_sources: expectedSources,
    resolved_sources: resolvedSources,
    unavailable_sources: unavailableSources,
    overflow_sources: parentTurn.overflow_count ?? 0,
    metadata_status: aggregateMetadataStatus(parentTurn),
    metadata_confidence: aggregateMetadataConfidence(parentTurn),
    ...(aggregateMetadataSource(parentTurn) ? { metadata_source: aggregateMetadataSource(parentTurn) } : {}),
    workflow_context: workflowContextForReceipt({ metadata: parentTurn.main?.metadata }, state.usage?.config?.workflow_advisor),
    ...(builtUsage.usageLayers ? { usage_layers: builtUsage.usageLayers, usage_coverage: builtUsage.coverage } : {}),
    ...(planComparison ? { plan_comparison: planComparison } : {}),
    efficiency,
    ponytail: aggregatePonytail(parentTurn),
  });
  const summary = metadataSummary(parentTurn, receipt.ponytail?.mode);
  if (summary) receipt.metadata_summary = summary;
  else delete receipt.metadata_summary;
  parentTurn.receipt = receipt;
  parentTurn.updated_at = timestamp();
  annotateUsageOutlier(state, receipt);
  recordUsageSnapshot(state, runtime, builtUsage.usageLayers, receipt, {
    reconcile: true,
    previousUsageLayers,
  });
  if (state.usage?.config?.local_budgets && typeof state.usage.config.local_budgets === 'object') {
    updateSessionUsageTotals(state, receipt, builtUsage.usageLayers, { previousReceipt, previousUsageLayers });
  }
  return status;
}

function reconcileClosedParentAfterSubagent(state, sourceScope, agentHash, childTurnHash, entry, input, runtime, env) {
  const parentTurnHash = sourceScope?.parent_turn;
  if (!sourceScope?.closed || typeof parentTurnHash !== 'string' || !/^[a-f0-9]{20}$/.test(parentTurnHash)) return false;
  const parentTurn = state.turns?.[parentTurnHash];
  const receipt = state.receipts.find((candidate) => candidate?.turn_id === parentTurnHash) ?? parentTurn?.receipt;
  const parentChild = parentTurn?.subagents?.[agentHash];
  const generation = sessionGeneration(state, input, runtime);
  const sessionMatches = receipt?.session === sessionIdentity(runtime, input.session_id)
    && (Number.isSafeInteger(receipt.session_generation) ? receipt.session_generation : 0) === generation;
  if (!receipt || receipt.status !== 'partial' || !sessionMatches
    || !parentTurn?.main?.valid || !parentTurn.main.usage
    || !parentChild || parentChild.child_turn !== childTurnHash
    || entry.status !== 'completed' || !entry.usage) return false;

  parentTurn.subagents[agentHash] = {
    ...parentChild,
    status: 'completed',
    ambiguous: entry.ambiguous === true,
    usage: tokenFields(entry.usage),
    usage_source: 'transcript',
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ponytail: persistedPonytail(entry.ponytail),
    updated_at: timestamp(),
  };
  refreshClosedParentReceipt(state, parentTurn, receipt, input, runtime, env);
  return true;
}

function processSubagentStop(state, input, runtime = 'codex', env = {}) {
  const generation = sessionGeneration(state, input, runtime);
  const child = childIdentity(input, runtime, generation);
  const agentHash = child.agentHash;
  const knownLink = state.agent_scopes[agentHash];
  const staleGenerationLink = !knownLink && child.lifecycleAgentId && child.lifecycleTurnId
    ? Object.values(state.agent_scopes).find((entry) => (
      entry?.session === sessionIdentity(runtime, input.session_id)
      && entry.lifecycle_agent_id === child.lifecycleAgentId
      && entry.lifecycle_turn_id === child.lifecycleTurnId
      && (Number.isSafeInteger(entry.session_generation) ? entry.session_generation : 0) !== generation
    ))
    : null;
  const knownLinkSessionMatches = !knownLink || (knownLink.session === sessionIdentity(runtime, input.session_id)
    && (Number.isSafeInteger(knownLink.session_generation) ? knownLink.session_generation : 0) === generation);
  // SessionStart can legally reuse a host session id as a new generation.
  // A delayed child event linked to the old generation cannot be attributed to
  // the new one, and retaining an unlinked placeholder would only consume
  // bounded state without contributing safe accounting evidence.
  if ((knownLink && !knownLinkSessionMatches) || staleGenerationLink) return {};
  const childTurnHash = turnIdentity(runtime, input.session_id, input.turn_id, generation, 'subagent', child.sourceId ?? child.agentHash);
  const turn = ensureTurn(state, childTurnHash);
  const targetScopeId = scopeIdentity(runtime, input.session_id, input.turn_id, generation);
  const targetScope = targetScopeId ? ensureScope(state, targetScopeId) : null;
  const entry = turn.subagents[agentHash] ?? {
    agent_id: agentHash,
    status: 'pending',
    ...(child.sourceId ? { source_id: child.sourceId } : {}),
  };
  if (entry.status === 'completed' || entry.status === 'unavailable') {
    incrementHealth(state, 'duplicate_hooks');
    incrementHealth(state, 'duplicate_events');
    return {};
  }
  const childTranscriptPath = typeof input.agent_transcript_path === 'string'
    && input.agent_transcript_path.length > 0
    && input.agent_transcript_path !== input.transcript_path
    ? input.agent_transcript_path
    : null;
  // A shared or undeclared child transcript has no safe counter boundary from
  // the parent. Preserve it as an unresolved source rather than double-count
  // the same cumulative snapshot as both main and child usage.
  const result = childTranscriptPath && child.sourceId
    ? updateThread(state, threadIdentity('subagent', child.sourceId), childTranscriptPath, child.sourceId, null, { runtime, session_id: input.session_id, turn_id:input.turn_id })
    : { valid: false, ambiguous: true, reason: 'source-mismatch' };
  entry.metadata = mergeRuntimeMetadata(entry.metadata, hookMetadata(input, 'worker'), result.metadata);
  entry.ponytail = result.ponytail;
  entry.updated_at = timestamp();
  const link = knownLink;
  const sourceScope = link?.source_scope && state.scopes[link.source_scope]
    ? state.scopes[link.source_scope]
    : null;
  const sessionMatches = knownLinkSessionMatches;
  const childIdentityMatches = !link?.child_source_id
    || !child.sourceId
    || link.child_source_id === child.sourceId;
  // Agent ids and even child transcript handles can be reused by a host. The
  // safe turn hash is the remaining lifecycle boundary: an old completion
  // must never consume a newer generation's active child link.
  const childTurnMatches = !link?.child_turn || link.child_turn === childTurnHash;
  if (!link || !sourceScope || !sessionMatches || !childIdentityMatches || !childTurnMatches) {
    // A Stop may win the lock race against its matching Start. Keep only its
    // bounded numeric delta on the child turn, never attach it to a parent,
    // and require the later Start to prove the same safe turn/transcript
    // boundary before it can be reconciled.
    const priorCandidate = entry.status === 'pending'
      && entry.reason === 'source-mismatch'
      && entry.usage_source === 'transcript'
      && Boolean(entry.usage);
    entry.status = 'pending';
    entry.ambiguous = entry.ambiguous === true || result.ambiguous === true;
    entry.reason = 'source-mismatch';
    if (result.valid && result.delta) {
      // Serial lock ownership makes successive deltas disjoint. Accumulating
      // them preserves a real later increment while a duplicate Stop's zero
      // delta cannot erase the candidate needed by a later matching Start.
      if (priorCandidate && USAGE_KEYS.every((key) => result.delta[key] === 0)) {
        incrementHealth(state, 'duplicate_hooks');
        incrementHealth(state, 'duplicate_events');
      }
      entry.usage = tokenFields(priorCandidate ? sumUsage([entry.usage, result.delta]) : result.delta);
      entry.usage_source = 'transcript';
    } else if (!priorCandidate) {
      delete entry.usage;
      delete entry.usage_source;
    }
    turn.subagents[agentHash] = entry;
    turn.updated_at = timestamp();
    if (targetScope) targetScope.updated_at = timestamp();
    return {};
  }
  entry.status = result.valid ? 'completed' : 'unavailable';
  entry.ambiguous = result.ambiguous;
  entry.reason = result.reason;
  entry.usage = result.valid ? tokenFields(result.delta) : undefined;
  if (result.valid) entry.usage_source = 'transcript';
  else delete entry.usage_source;
  entry.metadata_status = entry.metadata.status;
  entry.metadata_source = entry.metadata.source;
  turn.subagents[agentHash] = entry;
  const active = sourceScope.active[agentHash] ?? {
    agent_id: agentHash,
    child_turn: childTurnHash,
    generation: link?.generation ?? targetScope.generation,
  };
  delete sourceScope.active[agentHash];
  sourceScope.completed[agentHash] = {
    agent_id: agentHash,
    child_turn: childTurnHash,
    ...(child.sourceId ? { child_source_id: child.sourceId } : {}),
    generation: active.generation,
    session_generation: generation,
    status: entry.status,
    ambiguous: entry.ambiguous === true,
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(SUBAGENT_USAGE_SOURCES.has(entry.usage_source) ? { usage_source: entry.usage_source } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ponytail: persistedPonytail(entry.ponytail),
    updated_at: timestamp(),
  };
  if (link) {
    state.agent_scopes[agentHash] = {
      ...link,
      status: entry.status,
      open: link.open === true,
      updated_at: timestamp(),
    };
  }
  // The lifecycle link, not a potentially different current transcript field,
  // owns the child. Reconcile a closed parent before preserving the historical
  // pre-parent-Stop behavior of reopening an unresolved source scope.
  const reconciledClosedParent = reconcileClosedParentAfterSubagent(
    state,
    sourceScope,
    agentHash,
    childTurnHash,
    entry,
    input,
    runtime,
    env,
  );
  if (sourceScope !== targetScope && !reconciledClosedParent) sourceScope.closed = false;
  if (entry.status === 'unavailable') incrementHealth(state, 'unavailable_receipts');
  sourceScope.updated_at = timestamp();
  if (targetScope) targetScope.updated_at = timestamp();
  turn.updated_at = timestamp();
  return {};
}

function finalizePendingTelemetry(state, sessionHash, generation = 0, reconciliationOutcome = undefined) {
  if (!sessionHash) return;
  for (const receipt of state.receipts) {
    if (receipt?.session !== sessionHash
      || (Number.isSafeInteger(receipt.session_generation) ? receipt.session_generation : 0) !== generation
      || receipt.telemetry_reconciliation?.state !== 'pending_post_turn') continue;
    const finalized = {
      ...receipt.telemetry_reconciliation,
      state: 'unavailable',
      source: 'none',
      attempts: Math.min(MAX_TURNS, (receipt.telemetry_reconciliation.attempts ?? 0) + 1),
      outcome: terminalTelemetryOutcome(receipt.telemetry_reconciliation.outcome, reconciliationOutcome),
    };
    receipt.telemetry_reconciliation = finalized;
    const turn = state.turns?.[receipt.turn_id];
    if (turn?.receipt) turn.receipt.telemetry_reconciliation = finalized;
  }
}

function hotContextSessions(state, runtime) {
  const host = runtime === 'claude' ? 'claude' : 'codex';
  const entries = Object.entries(state?.advisor?.sessions ?? {})
    .filter(([session, record]) => /^[a-f0-9]{20}$/.test(session)
      && record?.host === host
      && record.closed_at === null
      && Number.isSafeInteger(record.generation)
      && record.generation >= 0)
    .slice(-MAX_THREADS);
  return Object.fromEntries(entries.map(([session, record]) => [session, {
    generation: Math.min(record.generation, MAX_HEALTH_COUNTER),
  }]));
}

function saveHotContext(stateDir, state, runtime) {
  const fingerprint = stateFingerprint(stateDir);
  if (!fingerprint) return false;
  const payload = {
    hot_context_schema_version: HOT_CONTEXT_SCHEMA_VERSION,
    runtime: runtime === 'claude' ? 'claude' : 'codex',
    state_size: fingerprint.size,
    state_mtime_ms: fingerprint.mtime_ms,
    last_public_bridge_attempt: Number.isSafeInteger(state?.public_bridge?.last_attempted_at)
      && state.public_bridge.last_attempted_at >= 0
      ? state.public_bridge.last_attempted_at
      : 0,
    sessions: hotContextSessions(state, runtime),
  };
  const serialized = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) return false;
  const target = hotContextFile(stateDir);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  let fd,owned;
  let committed = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    committed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
    if (!committed) {
      try { unlinkOwnedFile(temp,owned); } catch { /* fail open */ }
    }
  }
}

function recordLockTimeout(stateDir, runtime = 'unknown') {
  const lock = path.join(stateDir, LOCK_FILE);
  let held;
  try {
    ensureStateDirectory(stateDir);
    held = tryFileLock(lock);
    if (!held) return;
    const state = loadState(stateDir, runtime);
    incrementHealth(state, 'lock_timeouts');
    saveState(stateDir, state);
    saveHotContext(stateDir, state, runtime);
  } catch {
    // A concurrent writer still owns the lock; do not race or block Codex.
  } finally {
    if (held) releaseFileLock(lock, held);
  }
}

export async function handleHook(input, eventName, env = process.env, deferred = undefined) {
  // The hook entry passes the fast-path result so a busy lock is not waited on twice.
  const fastPath = deferred ?? await deferHookEvent(input, eventName, env);
  if (fastPath === 'handled' || fastPath === 'ignored') return {};
  const name = eventName || input?.hook_event_name;
  const runtime = env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : 'codex';
  const hookEnv = hookEnvironment(env, runtime);
  const normalizedEvent = runtime === 'claude'
    ? normalizeClaudeHook({ ...(input ?? {}), hook_event_name: name })
    : normalizeCodexHook({ ...(input ?? {}), hook_event_name: name });
  if (!normalizedEvent) return {};
  // Claude streams MessageDisplay batches synchronously. Only its documented
  // final marker can stage bounded numeric usage before Stop or reconcile a
  // prior pending Stop; every non-final batch is intentionally ignored before
  // state, locks, or public bridge work so response text cannot enter
  // SomesToken state or add display latency.
  if (runtime === 'claude' && name === 'MessageDisplay' && input?.final !== true) return {};
  const acceptance = readLiveAcceptanceContext(hookEnv, runtime);
  const dataRoot = isHostOwnedAbsolutePath(hookEnv.PLUGIN_DATA) ? hookEnv.PLUGIN_DATA : null;
  if (!dataRoot) return {};
  const stateDir = path.join(dataRoot, STATE_DIR_NAME);
  const durableState = !NON_DURABLE_EVENTS.has(name);
  if (fastPath === 'lock_timeout') {
    recordLockTimeout(stateDir, runtime);
    return {};
  }
  try {
    return await withLock(stateDir, async () => {
      const state = loadState(stateDir, runtime, { preserveLimitRecovery: name === 'SessionEnd' });
      const deferredHotEvents = drainDeferredHotEvents(stateDir, state, runtime);
      const advisorRetention = expireAdvisorState(state.advisor, timestamp());
      if (advisorRetention.dropped > 0) {
        incrementHealth(state, 'state_retention_drops', advisorRetention.dropped);
        incrementHealth(state, 'retention_drops', advisorRetention.dropped);
      }
      const configured = readSomesTokenConfig(hookEnv);
      if (configured.source === 'environment' && configured.config) {
        state.usage.config = configured.config;
        state.usage.selected_plan = configured.config.plan.provider === runtime
          ? { provider: configured.config.plan.provider, id: configured.config.plan.id }
          : { provider: 'unknown', id: 'unknown' };
      }
      if (state.usage?.selected_plan?.provider !== 'unknown' && state.usage.selected_plan.provider !== runtime) {
        state.usage.selected_plan = { provider: 'unknown', id: 'unknown' };
      }
      const quotaSnapshot = recordQuotaSnapshot(state, input ?? {});
      const thresholdWarnings = recordUsageThresholdAlerts(state, quotaSnapshot);
      const efficiency = recordEfficiencyEvent(state, input ?? {}, name, runtime, { acceptance, normalized: normalizedEvent });
      if (runtime === 'claude' && name !== 'MessageDisplay') invalidateClaudeFinalSnapshots(state, input ?? {}, name);
      let response = {};
      // A final Claude MessageDisplay can need durable private state so Stop
      // can consume its numeric stage, but a stage alone creates no public
      // receipt or report change. Deferring the public snapshot write keeps
      // this display-blocking hook bounded. A successful pending-receipt
      // reconciliation below opts back in because that is public data.
      let publishPublicBridge = durableState && name !== 'MessageDisplay';
      if (efficiency?.missing_session_identity) {
        if (name === 'Stop' || name === 'StopFailure') {
          response = { systemMessage: 'SomesToken · usage unavailable · telemetry source unavailable · Next: check SomesToken diagnostics.' };
        }
      }
      else if (name === 'SessionStart' && !efficiency?.duplicate_session_start) response = processSessionStart(state, input ?? {}, runtime);
      // SessionEnd is authoritative for the current generation. Lifecycle
      // hooks can arrive after it because hosts execute command hooks
      // concurrently; recordEfficiencyEvent has already counted those late
      // events, but they must not reopen or mutate the closed source graph.
      else if (name === 'SubagentStart' && !efficiency?.late_event) response = processSubagentStart(state, input ?? {}, runtime, hookEnv);
      else if (name === 'SubagentStop' && !efficiency?.late_event) response = processSubagentStop(state, input ?? {}, runtime, hookEnv);
      // A subsequent prompt cannot prove that the readable transcript belongs
      // to the preceding pending Stop. In particular, transcript locations
      // are deliberately not identities: using path equality here would both
      // weaken privacy and permit cross-turn attachment. Terminalize the old
      // receipt conservatively; only the official final MessageDisplay
      // boundary or SessionEnd may reconcile it.
      else if (name === 'UserPromptSubmit' && runtime === 'claude' && !efficiency?.late_event) {
        finalizePendingTelemetry(
          state,
          sessionIdentity('claude', input?.session_id),
          sessionGeneration(state, input ?? {}, 'claude'),
          'transcript_ambiguous',
        );
      }
      else if (name === 'MessageDisplay' && runtime === 'claude' && normalizedEvent.final === true && !efficiency?.late_event) {
        const stagedTurn = stageClaudeFinalSnapshot(state, input ?? {});
        const reconciliation = reconcilePendingClaudeTranscript(state, input ?? {}, hookEnv);
        if (reconciliation.reconciled === true && stagedTurn) delete state.claude_final_snapshots?.[stagedTurn];
        publishPublicBridge = reconciliation.reconciled === true;
      }
      else if (name === 'Stop' && !efficiency?.late_event) response = responseForStop(state, input ?? {}, runtime, efficiency, hookEnv, thresholdWarnings);
      else if (name === 'StopFailure' && !efficiency?.late_event) response = responseForStopFailure(state, input ?? {}, runtime, efficiency);
      else response = {};
      if (name === 'SessionEnd' && !efficiency?.ignored_session_end && !efficiency?.missing_session_identity) {
        reconcileSession(state, input ?? {}, runtime, hookEnv);
        if (runtime === 'codex' && state.limit_recovery
          && !['disabled', 'resumed', 'canceled', 'expired', 'unavailable', 'interrupted'].includes(state.limit_recovery.state)) {
          const previousLimitRecoveryState = state.limit_recovery.state;
          state.limit_recovery = transitionLimitRecovery(state.limit_recovery, { type: 'session_end' });
          recordLimitRecoveryTransitionHealth(state, previousLimitRecoveryState, state.limit_recovery);
        }
        if (runtime === 'claude') clearClaudeFinalSnapshots(
          state,
          sessionIdentity('claude', input?.session_id),
          sessionGeneration(state, input ?? {}, 'claude'),
        );
      }
      if (!efficiency?.missing_session_identity && !efficiency?.late_event) {
        if(['SessionStart','UserPromptSubmit'].includes(name)
          &&(runtime==='codex'?configuredCodexLedgerRoot(hookEnv,hookEnv.PLUGIN_ROOT):configuredClaudeWorkspaceRoot(hookEnv)))
          captureTaskForecastProfile(workspaceDirectory(hookEnv),input??{},runtime,name);
        const policyContext = activePolicyHookContext(state.optimization.active_policies, {
          host: runtime, session_id: input?.session_id, cwd: input?.cwd, event: name, source: input?.source,
        });
        if (policyContext) response.hookSpecificOutput = policyContext;
        if(['SessionStart','UserPromptSubmit','PostCompact','Stop','StopFailure','SessionEnd'].includes(name)){
          const selection=activeTaskPolicy(state.optimization.active_policies,{host:runtime,session_id:input?.session_id,cwd:input?.cwd});
          const enabled=Boolean(runtime==='codex'?configuredCodexLedgerRoot(hookEnv,hookEnv.PLUGIN_ROOT):configuredClaudeWorkspaceRoot(hookEnv));
          const lifecycle=recordLifecycleEvent(state.optimization.lifecycle_checks,{
            host:runtime,session_id:input?.session_id,event:name,source:input?.source,
            duplicateStart:efficiency?.duplicate_session_start===true,developmentRequired:selection?.development_required===true,
            enabled,monitor:enabled?readWorkspaceFile(workspaceDirectory(hookEnv),'monitor.json'):null,
          });
          if(lifecycle.needs_context&&['SessionStart','UserPromptSubmit'].includes(name))response.hookSpecificOutput={
            hookEventName:name,additionalContext:policyContext?policyContext.additionalContext+'\n'+DEVELOPMENT_CONTEXT:DEVELOPMENT_CONTEXT};
        }
        if (['SessionStart','UserPromptSubmit'].includes(name)) {
          try { rememberPluginData(hookEnv, runtime); } catch { /* The handoff CLI and the Codex MCP reporter find host data through it. */ }
        }
        if (['SessionStart','UserPromptSubmit','PostToolUse'].includes(name)) {
          let handoff = null;
          // The optional handoff must never cost the event its collection.
          try { handoff = handoffHookResponse(state.optimization, { host: runtime, session_id: input?.session_id, cwd: input?.cwd, event: name, source: input?.source }, hookEnv); }
          catch { /* No notice this time; the next supported hook retries. */ }
          if (handoff?.context) response.hookSpecificOutput = { hookEventName: name,
            additionalContext: [response.hookSpecificOutput?.additionalContext, handoff.context].filter(Boolean).join('\n') };
          if (handoff?.message) response.systemMessage = [response.systemMessage, handoff.message].filter(Boolean).join('\n');
        }
      }
      if (!publishPublicBridge && shouldRefreshActivePublicBridge(state, name, efficiency)) {
        publishPublicBridge = true;
      }
      // High-frequency tool/permission telemetry remains in private bounded
      // state until the next lifecycle or receipt boundary, except for one
      // fixed-lease active heartbeat. This keeps the public bridge cheap and
      // guarantees that readers never observe a half-updated event stream.
      if (publishPublicBridge) {
        const bridgeWritten = writePublicBridge({ ...hookEnv, SOMESTOKEN_RUNTIME: runtime }, state);
        incrementHealth(state, bridgeWritten ? 'public_snapshots_written' : 'public_snapshot_write_failures');
      }
      saveState(stateDir, state, { durable: durableState });
      if (deferredHotEvents.should_reset) resetHotEvents(stateDir, deferredHotEvents.epoch);
      saveHotContext(stateDir, state, runtime);
      return response;
    });
  } catch (error) {
    if (error?.message === 'state-lock-timeout') recordLockTimeout(stateDir, runtime);
    return {};
  }
}

/**
 * Bounded local mutation surface used by the v0.4 optimization CLI.  It is
 * intentionally not exposed through MCP and never accepts a state path.
 */
export async function mutateOptimizationState(env = process.env, operation) {
  const dataRoot = pluginDataRoot(env);
  if (!dataRoot || typeof operation !== 'function') return { ok: false, error: 'plugin_data_unavailable' };
  const runtime = env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : env.SOMESTOKEN_RUNTIME === 'codex' ? 'codex' : 'unknown';
  const stateDir = path.join(dataRoot, STATE_DIR_NAME);
  try {
    return await withLock(stateDir, async () => {
      const state = loadState(stateDir, runtime);
      state.optimization = state.optimization && typeof state.optimization === 'object' ? state.optimization : createOptimizationState();
      const result = await operation(state.optimization, state);
      // Refused operations do not commit incidental normalization, health or
      // public-bridge changes. The lock still releases through withLock.
      if (result?.ok === false) return result;
      refreshOptimizationDerivedState(state.optimization);
      trimOptimizationState(state.optimization);
      const bridgeWritten = writePublicBridge({
        ...env,
        ...(runtime === 'codex' || runtime === 'claude' ? { SOMESTOKEN_RUNTIME: runtime } : {}),
      }, state);
      incrementHealth(state, bridgeWritten ? 'public_snapshots_written' : 'public_snapshot_write_failures');
      saveState(stateDir, state);
      saveHotContext(stateDir, state, runtime);
      return result;
    });
  } catch (error) {
    if (error?.message === 'state-lock-timeout') recordLockTimeout(stateDir, runtime);
    return { ok: false, error: 'state_unavailable' };
  }
}

/**
 * Bounded mutation surface for the explicitly owned Codex limit-recovery
 * companion. Normal hooks never call this helper; it reuses the same lock,
 * atomic persistence, retention, and public bridge as other local state.
 */
export async function mutateLimitRecoveryState(env = process.env, operation) {
  const dataRoot = pluginDataRoot(env);
  if (!dataRoot || typeof operation !== 'function') return { ok: false, error: 'plugin_data_unavailable' };
  const runtime = env.SOMESTOKEN_RUNTIME === 'codex' ? 'codex' : env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : 'unknown';
  const stateDir = path.join(dataRoot, STATE_DIR_NAME);
  try {
    return await withLock(stateDir, async () => {
      const state = loadState(stateDir, runtime, { preserveLimitRecovery: true });
      state.limit_recovery = trimLimitRecoveryState(state.limit_recovery);
      const previousLimitRecoveryState = state.limit_recovery.state;
      const result = await operation(state.limit_recovery, state);
      state.limit_recovery = trimLimitRecoveryState(state.limit_recovery);
      recordLimitRecoveryTransitionHealth(state, previousLimitRecoveryState, state.limit_recovery);
      const bridgeWritten = writePublicBridge({
        ...env,
        ...(runtime === 'codex' || runtime === 'claude' ? { SOMESTOKEN_RUNTIME: runtime } : {}),
      }, state);
      incrementHealth(state, bridgeWritten ? 'public_snapshots_written' : 'public_snapshot_write_failures');
      saveState(stateDir, state);
      saveHotContext(stateDir, state, runtime);
      return result;
    });
  } catch (error) {
    if (error?.message === 'state-lock-timeout') recordLockTimeout(stateDir, runtime);
    return { ok: false, error: 'state_unavailable' };
  }
}

/**
 * Compare-and-set checkpoint for the managed companion. SessionEnd uses the
 * same durable record, so a stale controller generation cannot overwrite a
 * cancellation or begin a later host mutation. This remains local-only and is
 * intentionally not exposed through hooks or MCP.
 */
export async function checkpointLimitRecoveryState(env = process.env, nextState, expected = {}) {
  const next = trimLimitRecoveryState(nextState);
  const expectedOperationId = typeof expected.operation_id === 'string' ? expected.operation_id : null;
  const expectedGeneration = Number.isSafeInteger(expected.operation_generation) ? expected.operation_generation : null;
  return mutateLimitRecoveryState(env, (stored) => {
    const current = trimLimitRecoveryState(stored);
    const currentTerminal = ['disabled', 'resumed', 'canceled', 'expired', 'unavailable', 'interrupted'].includes(current.state);
    if (expectedOperationId === null) {
      if (next.state !== 'armed' || (current.state !== 'disabled' && !currentTerminal)) {
        return { ok: false, canceled: true, state: current };
      }
    } else if (current.operation_id !== expectedOperationId
      || current.operation_generation !== expectedGeneration
      || (currentTerminal && current.state !== 'disabled')) {
      return { ok: false, canceled: true, state: current };
    }
    Object.keys(stored).forEach((key) => { delete stored[key]; });
    Object.assign(stored, next);
    return { ok: true, state: next };
  });
}

function refreshOptimizationDerivedState(optimization) {
  const pairs = [];
  const reductions = [];
  for (const experiment of listExperiments(optimization?.experiments)) {
    const matched = findComparablePairs(experiment.runs, { comparison_axis: experiment.comparison_axis, experiment_id: experiment.experiment_id });
    for (const pair of matched) {
      pairs.push({
        pair_id: pair.pair_id,
        experiment_id: experiment.experiment_id,
        comparable: pair.comparable,
        reasons: pair.reasons,
        outcome_relation: pair.outcome_relation,
      });
      reductions.push(measureReduction(pair));
    }
  }
  optimization.pairs = pairs.slice(-128);
  optimization.reductions = reductions.slice(-128);
  optimization.counters ??= {};
  optimization.counters.experiment_pairs_valid = pairs.filter((pair) => pair.comparable).length;
  optimization.counters.experiment_pairs_incomparable = pairs.filter((pair) => !pair.comparable).length;
  optimization.counters.measured_reduction_pairs = reductions.filter((entry) => entry.status === 'measured').length;
}

export function readPublicState(env = process.env) {
  const dataRoot = pluginDataRoot(env);
  if (!dataRoot) return blankState();
  const runtime = env.SOMESTOKEN_RUNTIME === 'claude' ? 'claude' : env.SOMESTOKEN_RUNTIME === 'codex' ? 'codex' : 'unknown';
  const stateDir = path.join(dataRoot, STATE_DIR_NAME);
  if (!safeStateDirectory(stateDir)) return { ...blankState(), health: null };
  const state = loadState(stateDir, runtime);
  try {
    if (!fs.existsSync(stateFile(stateDir)) || state[RECOVERED_STATE]) return { ...state, health: null };
  } catch {
    return { ...state, health: null };
  }
  // A read-only reporter may run between hot hooks and the next lifecycle
  // boundary. Replay the bounded, already-sanitized journal in memory so
  // health and structural views stay current without rewriting state, public
  // bridge data, or the journal itself. The durable hook path will replay the
  // same epoch exactly once later using its persisted watermark.
  drainDeferredHotEvents(stateDir, state, runtime);
  return state;
}

export function retentionLimits() {
  return {
    maxTurns: MAX_TURNS,
    maxThreads: MAX_THREADS,
    maxTailBytes: MAX_TAIL_BYTES,
    maxStateBytes: MAX_STATE_BYTES,
    maxStateRetainedBytes: MAX_STATE_RETAINED_BYTES,
    maxStateStringBytes: MAX_STATE_STRING_BYTES,
    maxStateKeyBytes: MAX_STATE_KEY_BYTES,
    maxStateDepth: MAX_STATE_DEPTH,
    maxStateEntries: MAX_STATE_ENTRIES,
  };
}
