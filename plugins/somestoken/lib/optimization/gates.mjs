import {
  GATE_IDS,
  GATE_STATUSES,
  GATE_SOURCES,
  normalizeGateId,
  normalizeGateRecord,
  safeHost,
} from './schema.mjs';

export const GATE_SCHEMA_VERSION = 1;

export const GATE_CATALOG = Object.freeze({
  codex_hook_trust: { host: 'codex', requires: 'user_or_host', blocking_scope: 'release' },
  codex_desktop_receipt: { host: 'codex', requires: 'user_or_host', blocking_scope: 'release' },
  claude_marketplace_reload: { host: 'claude', requires: 'user_or_host', blocking_scope: 'release' },
  claude_live_acceptance: { host: 'claude', requires: 'user_or_host', blocking_scope: 'release' },
  official_account_quota: { host: 'unknown', requires: 'host', blocking_scope: 'release' },
  host_ui_rendering: { host: 'unknown', requires: 'user_or_host', blocking_scope: 'release' },
  plugin_data_bridge: { host: 'unknown', requires: 'host', blocking_scope: 'release' },
  ponytail_bridge: { host: 'unknown', requires: 'host', blocking_scope: 'release' },
});

function key(host, gateId) {
  return `${safeHost(host)}:${gateId}`;
}

function at(value, fallback = Date.now()) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

export function gateKey(host, gateId) {
  const normalized = normalizeGateId(gateId);
  return normalized ? key(host, normalized) : null;
}

export function getGate(state, host, gateId) {
  const gateKeyValue = gateKey(host, gateId);
  if (!gateKeyValue) return null;
  const existing = state?.[gateKeyValue];
  if (existing) return normalizeGateRecord(existing);
  const catalog = GATE_CATALOG[gateId];
  if (!catalog) return null;
  return normalizeGateRecord({
    gate_id: gateId,
    host: catalog.host === 'unknown' ? host : catalog.host,
    status: 'open',
    source: 'unknown',
    requires: catalog.requires,
    blocking_scope: catalog.blocking_scope,
  });
}

/** Upsert only fixed gate fields; arbitrary descriptions are not accepted. */
export function upsertGate(state, input = {}) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'invalid_gate_state' };
  const gateId = normalizeGateId(input.gate_id);
  if (!gateId || !GATE_CATALOG[gateId]) return { ok: false, error: 'invalid_gate_id' };
  const catalog = GATE_CATALOG[gateId];
  const host = catalog.host === 'unknown' ? safeHost(input.host) : catalog.host;
  const gateKeyValue = key(host, gateId);
  const prior = normalizeGateRecord(state[gateKeyValue], { gate_id: gateId, host });
  const now = at(input.updated_at ?? input.now);
  const nextStatus = GATE_STATUSES.includes(input.status) ? input.status : prior?.status ?? 'open';
  const revision = count(input.evidence_revision ?? prior?.evidence_revision);
  const next = normalizeGateRecord({
    ...(prior ?? {}),
    gate_id: gateId,
    host,
    status: nextStatus,
    source: GATE_SOURCES.includes(input.source) ? input.source : prior?.source ?? 'unknown',
    opened_at: prior?.opened_at ?? now,
    updated_at: now,
    evidence_revision: revision,
    requires: catalog.requires,
    blocking_scope: catalog.blocking_scope,
    expires_at: input.expires_at === null ? null : at(input.expires_at, prior?.expires_at ?? null),
  });
  state[gateKeyValue] = next;
  return { ok: true, gate: { ...next }, changed: JSON.stringify(prior) !== JSON.stringify(next) };
}

export function satisfyGate(state, gateId, options = {}) {
  return upsertGate(state, { ...options, gate_id: gateId, status: 'satisfied', evidence_revision: options.evidence_revision ?? ((getGate(state, options.host, gateId)?.evidence_revision ?? 0) + 1) });
}

export function summarizeGates(state) {
  const entries = Object.values(state ?? {}).map((value) => normalizeGateRecord(value)).filter(Boolean);
  const safe = entries.slice(-GATE_IDS.length).map((gate) => ({
    gate_id: gate.gate_id,
    host: gate.host,
    status: gate.status,
    source: gate.source,
    evidence_revision: gate.evidence_revision,
    requires: gate.requires,
    blocking_scope: gate.blocking_scope,
    updated_at: gate.updated_at,
  }));
  return {
    schema_version: GATE_SCHEMA_VERSION,
    gates: safe,
    open_count: safe.filter((gate) => gate.status === 'open').length,
    satisfied_count: safe.filter((gate) => gate.status === 'satisfied').length,
  };
}
