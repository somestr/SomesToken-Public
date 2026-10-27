import { CALIBRATION_FEEDBACK, normalizeCalibrationFeedback } from './schema.mjs';

export const CALIBRATION_SCHEMA_VERSION = 1;

export function recordCalibrationFeedback(state, input = {}) {
  const feedback = normalizeCalibrationFeedback(input);
  if (!feedback.feedback_id || feedback.feedback_id === 'unknown' || !CALIBRATION_FEEDBACK.includes(feedback.feedback)) return { ok: false, error: 'invalid_calibration_feedback' };
  if (!Array.isArray(state)) return { ok: false, error: 'invalid_calibration_state' };
  const duplicate = state.some((entry) => entry.feedback_id === feedback.feedback_id);
  if (duplicate) return { ok: true, duplicate: true, feedback };
  state.push(feedback);
  return { ok: true, duplicate: false, feedback };
}

export function calibrationReport(feedback) {
  const entries = (Array.isArray(feedback) ? feedback : []).map(normalizeCalibrationFeedback);
  const count = (value) => entries.filter((entry) => entry.feedback === value).length;
  return {
    calibration_schema_version: CALIBRATION_SCHEMA_VERSION,
    feedback_seen: entries.length,
    user_accepted_recommendation: count('useful'),
    user_rejected_recommendation: count('not_useful'),
    false_positive_marked: count('false_positive'),
    too_early: count('too_early'),
    too_late: count('too_late'),
    unknown: count('unknown'),
    thresholds_changed_automatically: false,
  };
}
