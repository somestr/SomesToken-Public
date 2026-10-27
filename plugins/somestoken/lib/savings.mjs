// Receipt-level savings are intentionally never estimated. Outcome-equivalent
// experiment reductions live in optimization/reductions.mjs and remain a
// separate, explicit evidence surface.
export function normalizeSavings() {
  return { status: 'unmeasured' };
}
