/**
 * Select a Shippo rate for per-parcel label purchase: UPS Ground Saver, then UPS Ground,
 * then cheapest non–express, then cheapest overall.
 * @param {object[]} rates — raw Shippo Rate objects from a shipment
 * @returns {object | null}
 */
export function selectLabelPurchaseRate(rates) {
  const list = Array.isArray(rates) ? rates.filter((r) => r && String(r.object_id || "").trim()) : [];
  if (!list.length) {
    return null;
  }
  const isUps = (r) => {
    const p = String(r?.provider || r?.provider_name || "").toUpperCase();
    return p.includes("UPS");
  };
  const name = (r) => String(r?.servicelevel?.name || r?.servicelevel_name || r?.description || "").toLowerCase();
  const token = (r) => String(r?.servicelevel?.token || r?.servicelevel_token || "").toLowerCase();
  const amountOf = (r) => (Number.isFinite(Number(r?.amount)) ? Number(r.amount) : Infinity);
  const sortByAmount = (a, b) => amountOf(a) - amountOf(b);

  const gSaver = list.find(
    (r) => isUps(r) && !isExpressRate(r) && (token(r).includes("ground_saver") || name(r).includes("ground saver")),
  );
  if (gSaver) {
    return gSaver;
  }
  const g = list.find(
    (r) =>
      isUps(r) &&
      !isExpressRate(r) &&
      name(r).includes("ground") &&
      !name(r).includes("saver") &&
      !name(r).includes("express") &&
      !name(r).includes("air"),
  );
  if (g) {
    return g;
  }
  const nonEx = list.filter((r) => !isExpressRate(r));
  if (nonEx.length) {
    return [...nonEx].sort(sortByAmount)[0];
  }
  return [...list].sort(sortByAmount)[0];
}

export function selectLabelPurchaseRateMatching(rates, desired = {}) {
  const list = Array.isArray(rates) ? rates.filter((r) => r && String(r.object_id || "").trim()) : [];
  if (!list.length) {
    return null;
  }
  const desiredToken = String(desired.servicelevelToken || desired.servicelevel_token || desired.token || "").trim().toLowerCase();
  const desiredName = String(desired.servicelevelName || desired.servicelevel_name || desired.name || "").trim().toLowerCase();
  const desiredProvider = String(desired.provider || desired.carrier || "").trim().toLowerCase();
  const providerOf = (r) => String(r?.provider || r?.provider_name || "").trim().toLowerCase();
  const tokenOf = (r) => String(r?.servicelevel?.token || r?.servicelevel_token || "").trim().toLowerCase();
  const nameOf = (r) => String(r?.servicelevel?.name || r?.servicelevel_name || "").trim().toLowerCase();
  const providerMatches = (r) => !desiredProvider || providerOf(r) === desiredProvider || providerOf(r).includes(desiredProvider) || desiredProvider.includes(providerOf(r));
  const byToken = desiredToken ? list.filter((r) => providerMatches(r) && tokenOf(r) === desiredToken) : [];
  if (byToken.length) {
    return byToken.sort((a, b) => (Number(a?.amount) || Infinity) - (Number(b?.amount) || Infinity))[0];
  }
  const byName = desiredName ? list.filter((r) => providerMatches(r) && nameOf(r) === desiredName) : [];
  if (byName.length) {
    return byName.sort((a, b) => (Number(a?.amount) || Infinity) - (Number(b?.amount) || Infinity))[0];
  }
  return null;
}

function isExpressRate(r) {
  const s = [r?.servicelevel?.name, r?.servicelevel_name, r?.description, r?.servicelevel?.token, r?.servicelevel_token, String(r?.provider || "")]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
  if (/\bexpress\b|\bexpedited\b|\bovernight\b|\bnext[ -]?day\b|2nd day|second day|priority express|int_express|international express|air service/.test(s)) {
    return true;
  }
  const attrs = r?.attributes;
  if (Array.isArray(attrs) && attrs.some((a) => /express|overnight|fastest/i.test(String(a)))) {
    return true;
  }
  return false;
}
