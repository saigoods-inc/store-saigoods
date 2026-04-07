/**
 * US destination sales tax from env tables (basis points).
 * 975 = 9.75%. Not legal advice — confirm rates with your tax adviser.
 *
 * CHECKOUT_ZIP_TAX_BPS — optional JSON for location-specific combined rates:
 *   - 5-digit ZIP: { "90210": 1025, "10001": 8875 }
 *   - Or state+ZIP when the same ZIP appears in multiple contexts: { "CA:90210": 1025 }
 * Resolution order: STATE:ZIP → ZIP alone → CHECKOUT_STATE_TAX_BPS[state]
 */

let cachedStateBpsMap = null;
let cachedZipTables = null;

const MAX_BPS = 4000; /* 40% cap — room for high local combined rates */

function loadStateTaxBpsMap() {
  if (cachedStateBpsMap) {
    return cachedStateBpsMap;
  }

  const raw = process.env.CHECKOUT_STATE_TAX_BPS;
  if (raw == null || String(raw).trim() === "") {
    cachedStateBpsMap = {};
    return cachedStateBpsMap;
  }

  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cachedStateBpsMap = {};
      return cachedStateBpsMap;
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
      if (Number.isFinite(bps) && bps >= 0 && bps <= MAX_BPS) {
        out[code] = bps;
      }
    }
    cachedStateBpsMap = out;
    return cachedStateBpsMap;
  } catch {
    cachedStateBpsMap = {};
    return cachedStateBpsMap;
  }
}

/**
 * @returns {{ byZip: Record<string, number>, byStateZip: Record<string, number> }}
 */
function loadZipTaxTables() {
  if (cachedZipTables) {
    return cachedZipTables;
  }

  const raw = process.env.CHECKOUT_ZIP_TAX_BPS;
  if (raw == null || String(raw).trim() === "") {
    cachedZipTables = { byZip: {}, byStateZip: {} };
    return cachedZipTables;
  }

  const byZip = {};
  const byStateZip = {};

  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cachedZipTables = { byZip: {}, byStateZip: {} };
      return cachedZipTables;
    }

    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k || "").trim().toUpperCase();
      const bps = Math.round(Number(v));
      if (!Number.isFinite(bps) || bps < 0 || bps > MAX_BPS) {
        continue;
      }

      const compound = /^([A-Z]{2}):(\d{5})$/.exec(key);
      if (compound) {
        byStateZip[`${compound[1]}:${compound[2]}`] = bps;
        continue;
      }

      const digits = key.replace(/\D/g, "");
      if (digits.length >= 5) {
        byZip[digits.slice(0, 5)] = bps;
      }
    }
  } catch {
    /* ignore */
  }

  cachedZipTables = { byZip, byStateZip };
  return cachedZipTables;
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

function taxFromBps(bps, baseCents) {
  const base = Math.max(0, Math.round(Number(baseCents) || 0));
  if (base < 1 || bps == null || !Number.isFinite(bps)) {
    return 0;
  }
  return Math.round((base * bps) / 10000);
}

/**
 * Static tables only (ZIP / state). Used when TaxJar is off or as fallback.
 * @returns {{ taxCents: number, match: 'zip' | 'state_zip' | 'state' | 'none' }}
 */
export function resolveStaticUsTax(stateCode, zip5, taxableBaseCents) {
  const base = Math.max(0, Math.round(Number(taxableBaseCents) || 0));
  if (base < 1) {
    return { taxCents: 0, match: "none" };
  }

  const state = normalizeUsStateCode(stateCode);
  const zip = zip5 && /^\d{5}$/.test(zip5) ? zip5 : null;
  const { byZip, byStateZip } = loadZipTaxTables();

  if (state && zip) {
    const compound = byStateZip[`${state}:${zip}`];
    if (compound != null) {
      return { taxCents: taxFromBps(compound, base), match: "state_zip" };
    }
  }

  if (zip) {
    const zbps = byZip[zip];
    if (zbps != null) {
      return { taxCents: taxFromBps(zbps, base), match: "zip" };
    }
  }

  if (!state) {
    return { taxCents: 0, match: "none" };
  }

  const map = loadStateTaxBpsMap();
  const sbps = map[state];
  if (sbps == null || !Number.isFinite(sbps)) {
    return { taxCents: 0, match: "none" };
  }

  return { taxCents: taxFromBps(sbps, base), match: "state" };
}

/**
 * @param {string | null} stateCode - e.g. "TN"
 * @param {number} taxableBaseCents - merchandise ± shipping per CHECKOUT_TAX_INCLUDES_SHIPPING
 */
export function computeTaxCentsForState(stateCode, taxableBaseCents) {
  return resolveStaticUsTax(stateCode, null, taxableBaseCents).taxCents;
}

export function hasTaxRateForState(stateCode) {
  const state = normalizeUsStateCode(stateCode);
  if (!state) {
    return false;
  }
  return Object.hasOwn(loadStateTaxBpsMap(), state);
}
