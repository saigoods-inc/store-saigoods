function normalizedText(value) {
  return String(value || "").trim();
}

export function shippoRateAmount(rate) {
  const amount = Number.parseFloat(String(rate?.amount ?? ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : Infinity;
}

export function shippoRateKey(rate) {
  const provider = normalizedText(rate?.provider || rate?.provider_name).toLowerCase();
  const token = normalizedText(rate?.servicelevel?.token || rate?.servicelevel_token).toLowerCase();
  const name = normalizedText(rate?.servicelevel?.name || rate?.servicelevel_name).toLowerCase();
  const currency = normalizedText(rate?.currency || "USD").toUpperCase();
  if (!provider || (!token && !name)) return null;
  return `${provider}||${token || name}||${currency}`;
}

/**
 * Build purchasable multi-package services by intersecting the services returned
 * for every package and summing their individual label prices.
 */
export function aggregateShippoPackageRates(packageRateLists) {
  const lists = Array.isArray(packageRateLists) ? packageRateLists : [];
  if (!lists.length) return [];

  const packageRateMaps = lists.map((rates) => {
    const map = new Map();
    for (const rate of Array.isArray(rates) ? rates : []) {
      const key = shippoRateKey(rate);
      const amount = shippoRateAmount(rate);
      if (!key || !Number.isFinite(amount)) continue;
      const current = map.get(key);
      if (!current || amount < shippoRateAmount(current)) map.set(key, rate);
    }
    return map;
  });
  if (packageRateMaps.some((map) => map.size === 0)) return [];

  const commonKeys = [...packageRateMaps[0].keys()].filter((key) =>
    packageRateMaps.every((map) => map.has(key)),
  );

  return commonKeys.map((key) => {
    const rates = packageRateMaps.map((map) => map.get(key));
    const first = rates[0] || {};
    const provider = normalizedText(first?.provider || first?.provider_name);
    const token = normalizedText(first?.servicelevel?.token || first?.servicelevel_token);
    const name = normalizedText(first?.servicelevel?.name || first?.servicelevel_name) || "Shipping";
    const currency = normalizedText(first?.currency || "USD").toUpperCase() || "USD";
    const serviceId = token || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const estimatedDays = rates
      .map((rate) => Number(rate?.estimated_days))
      .filter((days) => Number.isFinite(days) && days > 0);
    const amount = rates.reduce((sum, rate) => sum + shippoRateAmount(rate), 0);

    return {
      object_id: `package-set:${provider.toLowerCase()}:${serviceId}:${rates.length}`,
      provider,
      carrier_account: first?.carrier_account || null,
      amount: amount.toFixed(2),
      currency,
      estimated_days: estimatedDays.length ? Math.max(...estimatedDays) : null,
      duration_terms: "",
      servicelevel_name: name,
      servicelevel_token: token || null,
      servicelevel: { name, token: token || null },
      attributes: first?.attributes || [],
      messages: first?.messages || [],
      package_rate_object_ids: rates.map((rate) => normalizedText(rate?.object_id)).filter(Boolean),
      package_rate_count: rates.length,
      rate_source: "per_package_label_sum",
    };
  });
}
