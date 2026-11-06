/** Upstream usage is untrusted. Invalid counts are unknown, never credit against a budget. */
export function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
