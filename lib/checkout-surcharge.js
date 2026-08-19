const DEFAULT_RESIDENTIAL_SURCHARGE_USD = 6.5;

function parseUsdToCents(envName, defaultUsd) {
  const raw = process.env[envName]?.trim();
  if (raw == null || raw === "") {
    return Math.round(Number(defaultUsd) * 100);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return Math.round(Number(defaultUsd) * 100);
  }
  return Math.round(n * 100);
}

/** Reads CHECKOUT_RESIDENTIAL_SURCHARGE_USD at call time (default $6.50 / 650¢). */
export function getCheckoutResidentialSurchargeCents() {
  return parseUsdToCents("CHECKOUT_RESIDENTIAL_SURCHARGE_USD", DEFAULT_RESIDENTIAL_SURCHARGE_USD);
}
