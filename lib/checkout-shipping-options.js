function cents(rate) {
  const value = Number(rate?.totalAmountCents ?? rate?.amountCents);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : Infinity;
}

function days(rate) {
  const value = Number(rate?.estimatedDays ?? rate?.estimated_days);
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

export function stableShippingServiceKey(rate) {
  const provider = String(rate?.provider || "").trim().toLowerCase();
  const service = String(rate?.serviceCode || rate?.serviceLabel || "").trim().toLowerCase();
  const currency = String(rate?.currency || "USD").trim().toUpperCase();
  return provider && service ? `${provider}||${service}||${currency}` : "";
}

/** Return only the cheapest and fastest whole-order services. */
export function selectCheckoutShippingChoices(rates) {
  const valid = (Array.isArray(rates) ? rates : []).filter(
    (rate) => stableShippingServiceKey(rate) && Number.isFinite(cents(rate)),
  );
  if (!valid.length) return [];

  const cheapest = [...valid].sort((a, b) => cents(a) - cents(b) || days(a) - days(b))[0];
  const withEta = valid.filter((rate) => Number.isFinite(days(rate)));
  const fastest = withEta.length
    ? [...withEta].sort((a, b) => days(a) - days(b) || cents(a) - cents(b))[0]
    : cheapest;

  const selected = [];
  for (const [role, rate] of [["cheapest", cheapest], ["fastest", fastest]]) {
    if (selected.some((entry) => stableShippingServiceKey(entry) === stableShippingServiceKey(rate))) {
      selected[0] = { ...selected[0], choiceRoles: [...new Set([...(selected[0].choiceRoles || []), role])] };
      continue;
    }
    selected.push({ ...rate, choiceRoles: [role] });
  }
  return selected;
}

export function shippingSelectionStillValid(previous, current) {
  if (!previous || !current) return false;
  return (
    stableShippingServiceKey(previous) === stableShippingServiceKey(current) &&
    cents(previous) === cents(current) &&
    days(previous) === days(current)
  );
}
