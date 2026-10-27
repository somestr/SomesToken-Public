import {parseTestReport,TEST_REPORT_FORMATS,MAX_TEST_REPORT_BYTES} from './test-report-formats.mjs';
const NODE_TEST_FORMAT = 'node-test-events-v1';
const STATUS_KEYS = Object.freeze(['pass', 'fail', 'cancelled', 'skip', 'todo']);
const STATUSES = new Set(STATUS_KEYS);
const DIAGNOSTIC_STREAMS = new Set(['stdout', 'stderr', 'diagnostic']);
const DEFAULT_MAX_BYTES = 16 * 1024;
const MAX_INLINE_DETAILS = 8;
const MAX_INLINE_LABEL_BYTES = 96;

const bytes = value => Buffer.byteLength(value, 'utf8');

export function clipUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  const text = String(value ?? '');
  const result = [];
  let used = 0;
  for (const sourceCharacter of text) {
    const codeUnit = sourceCharacter.charCodeAt(0);
    const character = sourceCharacter.length === 1 && codeUnit >= 0xD800 && codeUnit <= 0xDFFF ? '\uFFFD' : sourceCharacter;
    const size = bytes(character);
    if (used + size > maxBytes) break;
    result.push(character);
    used += size;
  }
  return result.join('');
}

function byteAccounting(input, output) {
  return { inputBytes: bytes(input.stdout) + bytes(input.stderr), outputBytes: bytes(output.stdout) + bytes(output.stderr),
    classification: 'bytes_only', tokenSavings: 'unmeasured' };
}

function passthrough(input, reason) {
  const summary = { stdout: input.stdout, stderr: input.stderr };
  return { mode: 'passthrough', exitCode: input.exitCode, signal: input.signal, summary, truncated: false, reason,
    byteAccounting: byteAccounting(input, summary) };
}

const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safePath = value => typeof value === 'string' ? value.replace(/[\r\n\0]/g, '').trim() : '';

function headerFor(counts) {
  return `${safeCount(counts.tests)} tests, ${safeCount(counts.suites)} suites: ${safeCount(counts.pass)} passed, ${safeCount(counts.fail)} failed, ${safeCount(counts.cancelled)} cancelled, ${safeCount(counts.skip)} skipped, ${safeCount(counts.todo)} todo\n`;
}

function markerFor(omitted, overflowPath, spillError) {
  const location = safePath(overflowPath);
  if (location) return `... output truncated; ${omitted} detail item(s) omitted; Full diagnostics: ${location}\n`;
  if (spillError) return `... output truncated; ${omitted} detail item(s) omitted; diagnostics unavailable: local_spill_failed\n`;
  return `... output truncated; ${omitted} detail item(s) omitted; original structured input remains caller-owned\n`;
}

/** Format already-aggregated Node test state without exceeding maxBytes. */
export function renderNodeTestSummary({ counts, details = [], detailCount, maxBytes, overflowPath, spillError = false }) {
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const header = headerFor(counts ?? {});
  const totalDetails = Math.max(safeCount(detailCount), details.length);
  const bounded = details.slice(0, MAX_INLINE_DETAILS).map(detail => {
    const label = String(detail?.label ?? 'DIAGNOSTIC');
    return { label: clipUtf8(label, MAX_INLINE_LABEL_BYTES), text: String(detail?.text ?? ''),
      truncated: detail?.truncated === true || bytes(label) > MAX_INLINE_LABEL_BYTES };
  });
  const full = header + bounded.map(detail => `${detail.label}\n${detail.text}\n`).join('');
  const complete = totalDetails === bounded.length && !bounded.some(detail => detail.truncated);
  if (complete && bytes(full) <= cap) return { stdout: full, truncated: false, omitted: 0 };

  const selected = [];
  for (const detail of bounded) {
    const candidate = [...selected, detail];
    const mandatory = header + candidate.map(entry => `${entry.label}\n`).join('')
      + markerFor(totalDetails - candidate.length, overflowPath, spillError);
    if (bytes(mandatory) > cap) break;
    selected.push(detail);
  }
  const omitted = totalDetails - selected.length;
  const marker = markerFor(omitted, overflowPath, spillError);
  const mandatory = header + selected.map(detail => `${detail.label}\n`).join('') + marker;
  if (bytes(mandatory) > cap) {
    return { stdout: clipUtf8(`TRUNCATED: ${totalDetails} detail item(s) omitted\n`, cap), truncated: true, omitted: totalDetails };
  }
  const textBudget = Math.max(0, cap - bytes(mandatory) - selected.length);
  const share = selected.length ? Math.floor(textBudget / selected.length) : 0;
  const body = selected.map(detail => `${detail.label}\n${clipUtf8(detail.text, share)}${share ? '\n' : ''}`).join('');
  return { stdout: clipUtf8(header + body + marker, cap), truncated: true, omitted };
}

function parseStructuredOutput(stdout, maxBytes) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.tests)) return null;
  if (value.diagnostics !== undefined && !Array.isArray(value.diagnostics)) return null;
  if (value.suites !== undefined && (!Number.isSafeInteger(value.suites) || value.suites < 0)) return null;
  const counts = { tests: value.tests.length, suites: safeCount(value.suites), pass: 0, fail: 0, cancelled: 0, skip: 0, todo: 0 };
  const details = [];
  let detailCount = 0;
  const remember = detail => {
    detailCount += 1;
    if (details.length < MAX_INLINE_DETAILS) details.push({ ...detail,
      label: clipUtf8(detail.label, MAX_INLINE_LABEL_BYTES), text: clipUtf8(detail.text, Math.min(maxBytes, 2048)),
      truncated: detail.truncated || bytes(detail.label) > MAX_INLINE_LABEL_BYTES
        || bytes(detail.text) > Math.min(maxBytes, 2048) });
  };
  for (const entry of value.tests) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || !STATUSES.has(entry.status)) return null;
    if (entry.diagnostic !== undefined && typeof entry.diagnostic !== 'string') return null;
    if (entry.diagnosticTruncated !== undefined && typeof entry.diagnosticTruncated !== 'boolean') return null;
    counts[entry.status] += 1;
    if (entry.status === 'fail' || entry.status === 'cancelled') remember({
      label: `${entry.status === 'cancelled' ? 'CANCELLED' : 'FAIL'} ${entry.name}`,
      text: entry.diagnostic || '(no diagnostic supplied)', truncated: entry.diagnosticTruncated === true,
    });
  }
  for (const entry of value.diagnostics ?? []) {
    if (!entry || !DIAGNOSTIC_STREAMS.has(entry.stream) || typeof entry.message !== 'string') return null;
    if (entry.truncated !== undefined && typeof entry.truncated !== 'boolean') return null;
    remember({ label: entry.stream.toUpperCase(), text: entry.message, truncated: entry.truncated === true });
  }
  return { counts, details, detailCount };
}

/** Unknown or malformed formats retain stdout and stderr byte-for-byte. */
export function projectToolResult(value = {}) {
  const input = { format: value.format, exitCode: value.exitCode ?? null, signal: value.signal ?? null,
    stdout: typeof value.stdout === 'string' ? value.stdout : '', stderr: typeof value.stderr === 'string' ? value.stderr : '' };
  if (!TEST_REPORT_FORMATS.includes(input.format)) return passthrough(input, 'unknown_format');
  if (bytes(input.stdout) > MAX_TEST_REPORT_BYTES) return passthrough(input, 'report_limit_exceeded');
  const maxBytes = Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0 ? value.maxBytes : DEFAULT_MAX_BYTES;
  const structured = input.format === NODE_TEST_FORMAT ? parseStructuredOutput(input.stdout, maxBytes) : parseTestReport(input.format,input.stdout,maxBytes);
  if (!structured) return passthrough(input, 'invalid_structured_output');
  const suffix = typeof value.suffix === 'string' ? value.suffix : '';
  if (bytes(suffix) >= maxBytes) return passthrough(input,'not_smaller');
  const projection = renderNodeTestSummary({ ...structured, maxBytes: maxBytes - bytes(suffix) });
  const summary = { stdout: projection.stdout + suffix, stderr: input.stderr };
  // Count the complete emitted candidate, including any receipt or retrieval instructions.
  if (bytes(summary.stdout) >= bytes(input.stdout)) return passthrough(input,'not_smaller');
  return { mode: 'projected', exitCode: input.exitCode, signal: input.signal, summary, truncated: projection.truncated,
    reason: projection.truncated ? 'max_bytes_exceeded' : input.format === NODE_TEST_FORMAT ? 'projected_node_test_events' : 'projected_test_report', byteAccounting: byteAccounting(input, summary) };
}
