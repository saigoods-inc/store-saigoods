/**
 * US state-code normalization for checkout destination handling.
 */

/** @param {string | null | undefined} raw */
export function normalizeUsStateCode(raw) {
  if (raw == null) {
    return null;
  }
  const s = String(raw).trim().toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) {
    return s;
  }
  return null;
}
