/**
 * Optional TaxJar SmartCalcs API — jurisdiction-accurate US sales tax from ship-from / ship-to.
 * https://developers.taxjar.com/api/reference/#post-calculate-sales-tax-for-an-order
 */

function taxJarEnabled() {
  const v = process.env.CHECKOUT_USE_TAXJAR;
  if (v != null && String(v).trim() !== "") {
    const s = String(v).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") {
      return false;
    }
  }
  return Boolean(process.env.TAXJAR_API_KEY?.trim());
}

export function isTaxJarConfigured() {
  if (!taxJarEnabled()) {
    return false;
  }
  const zip = process.env.TAXJAR_FROM_ZIP?.trim();
  const st = process.env.TAXJAR_FROM_STATE?.trim().toUpperCase();
  return Boolean(zip && st && /^[A-Z]{2}$/.test(st));
}

/**
 * @param {object} p
 * @param {number} p.subtotalCents
 * @param {number} p.shippingCents
 * @param {{ zip: string, state: string, country?: string, city?: string, line1?: string }} p.to
 */
export async function fetchTaxJarTaxCents(p) {
  const token = process.env.TAXJAR_API_KEY?.trim();
  const fromZip = process.env.TAXJAR_FROM_ZIP?.trim();
  const fromState = process.env.TAXJAR_FROM_STATE?.trim().toUpperCase();
  const fromCountry = (process.env.TAXJAR_FROM_COUNTRY || "US").trim().toUpperCase() || "US";
  const fromCity = process.env.TAXJAR_FROM_CITY?.trim() || undefined;
  const fromStreet = process.env.TAXJAR_FROM_STREET?.trim() || undefined;

  if (!token || !fromZip || !fromState) {
    throw new Error("TaxJar is not fully configured.");
  }

  const toZip = p.to.zip?.trim();
  const toState = p.to.state?.trim().toUpperCase();
  if (!toZip || !toState) {
    throw new Error("Destination ZIP and state are required for TaxJar.");
  }

  const subtotal = Math.max(0, Number(p.subtotalCents) || 0) / 100;
  const shipping = Math.max(0, Number(p.shippingCents) || 0) / 100;

  const body = {
    from_country: fromCountry,
    from_zip: fromZip,
    from_state: fromState,
    to_country: (p.to.country || "US").trim().toUpperCase() || "US",
    to_zip: toZip,
    to_state: toState,
    amount: Number(subtotal.toFixed(2)),
    shipping: Number(shipping.toFixed(2)),
  };

  if (fromCity) {
    body.from_city = fromCity;
  }
  if (fromStreet) {
    body.from_street = fromStreet;
  }
  if (p.to.city?.trim()) {
    body.to_city = p.to.city.trim();
  }
  if (p.to.line1?.trim()) {
    body.to_street = p.to.line1.trim();
  }

  const res = await fetch("https://api.taxjar.com/v2/taxes", {
    method: "POST",
    headers: {
      Authorization: `Token token="${token}"`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.error ||
      data?.detail ||
      (Array.isArray(data?.errors) && data.errors[0]?.message) ||
      `TaxJar HTTP ${res.status}`;
    throw new Error(String(msg));
  }

  const collect = data?.tax?.amount_to_collect;
  if (collect == null || !Number.isFinite(Number(collect))) {
    throw new Error("TaxJar returned no tax amount.");
  }

  return Math.round(Number(collect) * 100);
}
