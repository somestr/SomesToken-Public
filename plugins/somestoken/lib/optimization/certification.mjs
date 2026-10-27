import { validatePublicSnapshot } from '../public/validate.mjs';

export const POLICY_CERTIFICATION_SCHEMA_VERSION = 1;

const SAFE_MODES = new Set(['report_only', 'shadow']);
const LIVE_EVIDENCE = 'live_verified';

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function rate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Deterministic report-only policy certification. It never authorizes control. */
export function certifyPolicy(snapshot, policy = {}) {
  const checks = [];
  const valid = validatePublicSnapshot(snapshot);
  checks.push({ id: 'public_snapshot_valid', passed: valid.valid });
  const mode = typeof policy.mode === 'string' ? policy.mode : 'report_only';
  checks.push({ id: 'report_only_mode', passed: SAFE_MODES.has(mode) && mode === 'report_only' });
  checks.push({ id: 'no_host_control', passed: policy.block === undefined && policy.stop === undefined && policy.continue === undefined });
  const recommendationsSafe = Array.isArray(snapshot?.recommendations)
    && snapshot.recommendations.every((entry) => entry?.potential_savings === 'unmeasured');
  checks.push({ id: 'savings_unmeasured', passed: recommendationsSafe });
  const evidence = policy?.evidence && typeof policy.evidence === 'object' ? policy.evidence : null;
  let evidenceStatus = 'not_requested';
  let evidenceRecord = null;
  if (evidence) {
    const eligible = count(evidence.eligible_sessions);
    const triggered = count(evidence.triggered_sessions);
    const controls = count(evidence.non_triggered_controls);
    const falsePositives = count(evidence.false_positive_count);
    const falseNegatives = count(evidence.false_negative_count);
    const falsePositiveRate = rate(evidence.false_positive_rate)
      ?? (controls > 0 ? Math.min(1, falsePositives / controls) : null);
    const live = evidence.capability_coverage === LIVE_EVIDENCE || evidence.capability_evidence === LIVE_EVIDENCE;
    const privacy = evidence.privacy_passed === true;
    const privacyFailed = evidence.privacy_passed === false;
    const denominator = evidence.denominators_visible === true;
    const dominant = evidence.single_session_dominates === true;
    checks.push({ id: 'live_capability_evidence', passed: live });
    checks.push({ id: 'minimum_eligible_sessions', passed: eligible >= 10 });
    checks.push({ id: 'minimum_triggered_sessions', passed: triggered >= 3 });
    checks.push({ id: 'minimum_control_sessions', passed: controls >= 3 });
    checks.push({ id: 'privacy_passed', passed: privacy });
    checks.push({ id: 'denominators_visible', passed: denominator });
    checks.push({ id: 'single_session_not_dominant', passed: !dominant });
    checks.push({ id: 'false_positive_rate_visible', passed: falsePositiveRate !== null });
    evidenceRecord = {
      eligible_sessions: eligible,
      triggered_sessions: triggered,
      non_triggered_controls: controls,
      user_feedback_count: count(evidence.user_feedback_count),
      false_positive_count: falsePositives,
      false_negative_count: falseNegatives,
      false_positive_rate: falsePositiveRate,
      capability_coverage: live ? LIVE_EVIDENCE : 'insufficient_evidence',
      usage_quality_coverage: ['exact', 'partial', 'unavailable'].includes(evidence.usage_quality_coverage) ? evidence.usage_quality_coverage : 'unavailable',
      recommendation_acceptance: count(evidence.recommendation_acceptance),
    };
    const hardReject = !valid || !checks.find((entry) => entry.id === 'report_only_mode')?.passed
      || !checks.find((entry) => entry.id === 'no_host_control')?.passed
      || privacyFailed || dominant || (falsePositiveRate !== null && falsePositiveRate > 0.25);
    const enough = live && eligible >= 10 && triggered >= 3 && controls >= 3 && privacy && denominator && !dominant && falsePositiveRate !== null;
    evidenceStatus = hardReject ? 'rejected' : enough ? 'certified_for_warning' : eligible > 0 || triggered > 0 || controls > 0 ? 'collecting' : 'insufficient_evidence';
  }
  const basePassed = checks.slice(0, 4).every((entry) => entry.passed);
  const passed = basePassed && (!evidence || evidenceStatus === 'certified_for_warning' || evidenceStatus === 'not_requested');
  const status = !basePassed ? 'rejected' : evidence ? evidenceStatus : 'certified';
  return {
    policy_certification_schema_version: POLICY_CERTIFICATION_SCHEMA_VERSION,
    status,
    mode: 'report_only',
    checks,
    reason_codes: passed ? [] : checks.filter((entry) => !entry.passed).map((entry) => `policy_${entry.id}`),
    host: snapshot?.host === 'codex' || snapshot?.host === 'claude' ? snapshot.host : 'unknown',
    snapshot_state: snapshot?.snapshot_state ?? 'unavailable',
    ...(evidenceRecord ? { evidence: evidenceRecord } : {}),
  };
}
