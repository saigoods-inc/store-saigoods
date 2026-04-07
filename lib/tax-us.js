/**
 * US destination sales tax by state (you maintain rates in env).
 * Basis points: 975 = 9.75%. Not legal advice — confirm rates with your tax adviser.
 */

let cachedBpsMap = null;

function loadStateTaxBpsMap() {
  if (cachedBpsMap) {
    return cachedBpsMap;
  }

  const raw = process.env.CHECKOUT_STATE_TAX_BPS;
  if (raw == null || String(raw).trim() === "") {
    cachedBpsMap = {};
    return cachedBpsMap;
  }

  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cachedBpsMap = {};
      return cachedBpsMap;
    }

    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const code = String(k || "")
        .trim()
        .toUpperCase();
      if (code.length !== 2) {
        continue;
      }
      const bps = Math.round(Number(v));
      if (Number.isFinite(bps) && bps >= 0 && bps <= 3500) {
        out[code] = bps;
      }
    }
    cachedBpsMap = out;
    return cachedBpsMap;
  } catch {
    cachedBpsMap = {};
    return cachedBpsMap;
  }
}

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

/**
 * @param {string | null} stateCode - e.g. "TN"
 * @param {number} taxableBaseCents - merchandise ± shipping per CHECKOUT_TAX_INCLUDES_SHIPPING
 */
export function computeTaxCentsForState(stateCode, taxableBaseCents) {
  const state = normalizeUsStateCode(stateCode);
  const base = Math.max(0, Math.round(Number(taxableBaseCents) || 0));
  if (!state || base < 1) {
    return 0;
  }

  const map = loadStateTaxBpsMap();
  const bps = map[state];
  if (bps == null || !Number.isFinite(bps)) {
    return 0;
  }

  return Math.round((base * bps) / 10000);
}

export function hasTaxRateForState(stateCode) {
  const state = normalizeUsStateCode(stateCode);
  if (!state) {
    return false;
  }
  return Object.hasOwn(loadStateTaxBpsMap(), state);
}
