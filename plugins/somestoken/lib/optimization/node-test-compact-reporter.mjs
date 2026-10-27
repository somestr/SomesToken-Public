import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clipUtf8, renderNodeTestSummary } from './tool-output.mjs';

const DEFAULT_MAX_BYTES = 16 * 1024;
const MAX_PREVIEW_DETAILS = 8;

function configuredMaxBytes() {
  const value = Number(process.env.SOMESTOKEN_TEST_REPORT_MAX_BYTES);
  return Number.isSafeInteger(value) && value >= 256 && value <= 1024 * 1024 ? value : DEFAULT_MAX_BYTES;
}

function errorDiagnostic(error) {
  if (!error) return '(no diagnostic supplied)';
  if (typeof error === 'string') return error;
  if (typeof error.stack === 'string' && error.stack) return error.stack;
  if (typeof error.message === 'string' && error.message) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function failureStatus(data, error) {
  if (data.todo) return 'todo';
  if (data.skip) return 'skip';
  const failureType = String(error?.failureType ?? error?.code ?? '');
  return /cancel|timeout/i.test(failureType) ? 'cancelled' : 'fail';
}

function nativeTotal(message) {
  const match = String(message).match(/^(tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/);
  return match ? [match[1], Number(match[2])] : null;
}

function createSpill() {
  try {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'somestoken-node-test-'));
    const destination = path.join(directory, 'diagnostics.log');
    return { descriptor: fs.openSync(destination, 'wx', 0o600), destination };
  } catch { return null; }
}

/** Node custom reporter: counter-only for passes, bounded previews for details. */
export default async function* somesTokenCompactReporter(source) {
  const maxBytes = configuredMaxBytes();
  const fallback = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skip: 0, todo: 0 };
  const native = {};
  const failurePreviews = [];
  const diagnosticPreviews = [];
  const bufferedOriginals = [];
  let bufferedBytes = 0;
  let detailCount = 0;
  let spill = null;
  let spillFailed = false;

  const writeOriginal = (label, textValue) => {
    const parts = [`${label}\n`, String(textValue ?? ''), '\n'];
    const size = parts.reduce((total, part) => total + Buffer.byteLength(part, 'utf8'), 0);
    if (!spill && bufferedBytes + size > maxBytes) {
      spill = createSpill();
      if (spill) {
        for (const part of bufferedOriginals) fs.writeSync(spill.descriptor, part);
        bufferedOriginals.length = 0;
        bufferedBytes = 0;
      } else spillFailed = true;
    }
    if (spill) for (const part of parts) fs.writeSync(spill.descriptor, part);
    else if (!spillFailed) { bufferedOriginals.push(...parts); bufferedBytes += size; }
  };
  const addDetail = (kind, label, textValue, previewLabel = label) => {
    const text = String(textValue ?? '');
    detailCount += 1;
    writeOriginal(label, text);
    const previews = kind === 'failure' ? failurePreviews : diagnosticPreviews;
    const previewBytes = Math.min(maxBytes, 2048);
    if (previews.length < MAX_PREVIEW_DETAILS) previews.push({ label: clipUtf8(previewLabel, 96), text: clipUtf8(text, previewBytes),
      truncated: Buffer.byteLength(label, 'utf8') > 96 || Buffer.byteLength(text, 'utf8') > previewBytes });
  };

  try {
    for await (const event of source) {
      const data = event?.data ?? {};
      if (event?.type === 'test:pass' || event?.type === 'test:fail') {
        const suite = data.details?.type === 'suite';
        if (suite) {
          fallback.suites += 1;
          if (event.type === 'test:fail') addDetail('failure', `SUITE FAIL ${String(data.name ?? '(unnamed suite)')}`, errorDiagnostic(data.details?.error ?? data.error));
          continue;
        }
        const error = data.details?.error ?? data.error;
        const status = event.type === 'test:pass' ? data.todo ? 'todo' : data.skip ? 'skip' : 'pass' : failureStatus(data, error);
        fallback.tests += 1;
        fallback[status] += 1;
        if (status === 'fail' || status === 'cancelled') {
          const prefix = status === 'cancelled' ? 'CANCELLED' : 'FAIL';
          const label = `${prefix} ${String(data.name ?? '(unnamed test)')}`;
          // Startup failures use the file path as the test name. Keep the
          // filename visible in the preview and the full path in diagnostics.
          const preview = typeof data.file === 'string' && data.name === data.file && Buffer.byteLength(label, 'utf8') > 96
            ? `${prefix} ${path.basename(data.file)}` : label;
          addDetail('failure', label, errorDiagnostic(error), preview);
        }
      } else if (event?.type === 'test:stdout' || event?.type === 'test:stderr') {
        addDetail('diagnostic', event.type.slice('test:'.length).toUpperCase(), String(data.message ?? ''));
      } else if (event?.type === 'test:diagnostic') {
        const total = nativeTotal(data.message);
        if (total) native[total[0]] = total[1];
        else if (!/^duration_ms (?:\d+(?:\.\d+)?)$/.test(String(data.message))) addDetail('diagnostic', 'DIAGNOSTIC', String(data.message ?? ''));
      }
    }

    const counts = { tests: native.tests ?? fallback.tests, suites: native.suites ?? fallback.suites,
      pass: native.pass ?? fallback.pass, fail: native.fail ?? fallback.fail,
      cancelled: native.cancelled ?? fallback.cancelled, skip: native.skipped ?? fallback.skip, todo: native.todo ?? fallback.todo };
    const previews = [...failurePreviews, ...diagnosticPreviews].slice(0, MAX_PREVIEW_DETAILS);
    let projection = renderNodeTestSummary({ counts, details: previews, detailCount, maxBytes,
      overflowPath: spill?.destination, spillError: spillFailed });
    if (projection.truncated && !spill && !spillFailed) {
      spill = createSpill();
      if (spill) {
        for (const part of bufferedOriginals) fs.writeSync(spill.descriptor, part);
        bufferedOriginals.length = 0;
        projection = renderNodeTestSummary({ counts, details: previews, detailCount, maxBytes, overflowPath: spill.destination });
      } else {
        spillFailed = true;
        projection = renderNodeTestSummary({ counts, details: previews, detailCount, maxBytes, spillError: true });
      }
    }
    yield projection.stdout;
  } finally {
    if (spill?.descriptor !== undefined) fs.closeSync(spill.descriptor);
  }
}
