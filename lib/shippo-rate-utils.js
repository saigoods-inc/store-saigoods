/**
 * Normalize Shippo Rate objects for DB storage and admin display.
 * @param {object[]} rates
 */
export function normalizeRatesForStorage(rates) {
  const list = Array.isArray(rates) ? rates : [];
  return list.map((r) => ({
    object_id: r.object_id,
    provider: r.provider,
    carrier_account: r.carrier_account,
    amount: r.amount,
    currency: r.currency,
    estimated_days: r.estimated_days,
    duration_terms: r.duration_terms,
    servicelevel_name: r.servicelevel?.name,
    servicelevel_token: r.servicelevel?.token,
    attributes: r.attributes,
    messages: r.messages,
  }));
}

/**
 * @param {object[]} normalizedRates from normalizeRatesForStorage
 * @returns {object[]} UPS-like providers first, then others, by amount ascending within bucket
 */
export function sortRatesForAdminDisplay(normalizedRates) {
  const list = Array.isArray(normalizedRates) ? [...normalizedRates] : [];
  const isUps = (r) => String(r.provider || "").toUpperCase().includes("UPS") || String(r.provider || "").toLowerCase() === "ups";
  list.sort((a, b) => {
    const au = isUps(a) ? 0 : 1;
    const bu = isUps(b) ? 0 : 1;
    if (au !== bu) {
      return au - bu;
    }
    const na = Number(a.amount) || 0;
    const nb = Number(b.amount) || 0;
    return na - nb;
  });
  return list;
}
