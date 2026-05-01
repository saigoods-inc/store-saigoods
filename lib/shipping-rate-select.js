/**
 * Pick a Shippo rate for checkout: prefer UPS Ground Saver, then UPS Ground, then
 * the cheapest service that is not a typical expedited/overnight/2-day/3-day option.
 * @param {object[]} rates — Shippo Rate objects from a shipment
 * @returns {object | null} selected rate or null
 */
export function selectShippoRateForCheckout(rates) {
  const list = Array.isArray(rates) ? rates.filter((r) => r && typeof r === "object") : [];
  const withAmount = list.filter((r) => Number.isFinite(Number(r?.amount)) && amountCents(r) >= 0);
  if (!withAmount.length) {
    return null;
  }
  const groundish = withAmount.filter((r) => !isObviousExpressOrAirService(r));
  const pool = groundish.length > 0 ? groundish : withAmount;

  const gsaver = pool.find((r) => isUps(r) && isUpsGroundSaver(r));
  if (gsaver) {
    return gsaver;
  }
  const g = pool.find((r) => isUps(r) && isUpsStandardGround(r));
  if (g) {
    return g;
  }
  return [...pool].sort((a, b) => amountCents(a) - amountCents(b))[0] || null;
}

function amountCents(r) {
  return Math.max(0, Math.round((Number(r?.amount) || 0) * 100));
}

function getToken(r) {
  return String(r?.servicelevel?.token || r?.servicelevel_token || "").toLowerCase();
}
function getName(r) {
  return String(r?.servicelevel?.name || r?.servicelevel_name || "");
}
function isUps(r) {
  return String(r?.provider || r?.provider_name || "")
    .toLowerCase()
    .includes("ups");
}

function isUpsGroundSaver(r) {
  if (!isUps(r)) {
    return false;
  }
  const t = getToken(r);
  const n = getName(r).toLowerCase();
  if (t === "ups_ground_saver" || t.includes("ground_saver")) {
    return true;
  }
  return n.includes("ground") && n.includes("saver");
}

function isUpsStandardGround(r) {
  if (!isUps(r) || isUpsGroundSaver(r)) {
    return false;
  }
  if (getToken(r) === "ups_ground") {
    return true;
  }
  const n = getName(r).toLowerCase().replace(/\s+/g, " ").trim();
  return n === "ups ground";
}

/**
 * True = not "ground-like" for default selection (Next Day, 2nd Day, 3 Day, express air, etc.).
 */
function isObviousExpressOrAirService(r) {
  const t = getToken(r);
  const nLo = getName(r).toLowerCase();

  if (t === "ups_ground" || t === "ups_ground_saver") {
    return false;
  }
  if (nLo === "ups ground" || nLo === "usps ground") {
    return false;
  }
  if (nLo.includes("ground saver") && nLo.includes("ups") && isUps(r)) {
    return false;
  }
  if (t.startsWith("usps_ground") && !/express|overnight|priority_express|priority_mail_express/.test(t)) {
    return false;
  }
  if (t === "fedex_ground" || t === "fedex_home_delivery" || t.startsWith("fedex_ground_")) {
    return false;
  }
  if (
    nLo.includes("usps ground advantage") ||
    nLo.includes("ground advantage") ||
    nLo.includes("parcel select") ||
    nLo.includes("ground economy") ||
    nLo.includes("media mail")
  ) {
    return false;
  }
  if (t.includes("parcel_select") || t.includes("media_mail") || t.includes("surepost")) {
    return false;
  }
  if (t.includes("dhl_ground") || t.includes("ontrac_ground") || t.includes("lasership")) {
    return false;
  }

  if (
    /(next_day|2nd_day|2_day|3_day|3-day|one_day|overnight|priority_express|usps_priority_mail_express|saturday|sunday|second_day|third_day|_air(?!$)|\b_?air\/?)/.test(
      t,
    )
  ) {
    if (t === "ups_ground" || t === "usps_ground") {
      return false;
    }
    return !t.includes("usps_ground_") && !/ground$/.test(t);
  }

  if (/(^|\b)(next day|2nd day|3 day|3-day|3-day select|one day|1-day|2-day|overnight|standard overnight|priority express|express$|saturday|sunday|am delivery|early(?!$)|\b1 day\b)/i.test(nLo)) {
    if (nLo === "usps ground" || nLo === "usps ground advantage" || nLo === "usps ground advantage(™|)") {
      return false;
    }
    if (/ground advantage|usps ground|ups ground$|ground economy|parcel select|ground saver/.test(nLo) && !/2nd|next|3 day|air|overnight|one day|next day|priority express(?!$)/.test(nLo)) {
      return false;
    }
    return nLo !== "ups ground" && nLo !== "usps ground";
  }

  if (/\bexpress\b(?!$)/.test(nLo) && /priority(?! mail)|usps(?!$)|dhl(?!$)|next|overnight|1-day|2-day|3 day/i.test(nLo) && !/usps|ground(?!$)|parcel(?!$)/.test(nLo)) {
    return !nLo.includes("usps") && nLo.length > 0;
  }

  return /express|next|overnight|1-day|2-day|3 day|2nd|early|saturday|sunday|am\b(?!$)|air(?!$)/.test(
    nLo,
  ) && nLo !== "usps ground" && !nLo.includes("ground advantage") && !/parcel select|media mail|ground advantage|usps ground advantage/.test(nLo) && nLo !== "ups ground" && nLo !== "usps ground";
}

/**
 * Read-only snapshot: pool + candidates + which branch `selectShippoRateForCheckout` would take.
 * Does not change production selection behavior.
 */
export function debugShippoSelectionSnapshot(rates) {
  const list = Array.isArray(rates) ? rates.filter((r) => r && typeof r === "object") : [];
  const withAmount = list.filter((r) => Number.isFinite(Number(r?.amount)) && amountCents(r) >= 0);
  if (!withAmount.length) {
    return {
      withAmountCount: 0,
      poolSize: 0,
      usedFallbackToAllExpress: false,
      gsaverInPool: null,
      upsGroundInPool: null,
      cheapestInPool: null,
      selected: null,
      reason: "no_rates_with_amount",
    };
  }
  const groundish = withAmount.filter((r) => !isObviousExpressOrAirService(r));
  const pool = groundish.length > 0 ? groundish : withAmount;
  const selected = selectShippoRateForCheckout(rates);
  const gsaver = pool.find((r) => isUps(r) && isUpsGroundSaver(r));
  const ug = pool.find((r) => isUps(r) && isUpsStandardGround(r));
  const sortPool = [...pool].sort((a, b) => amountCents(a) - amountCents(b));
  const cheapest = sortPool[0] || null;

  let reason = "unknown";
  if (!selected) {
    reason = "no_selection";
  } else if (gsaver && selected?.object_id === gsaver?.object_id) {
    reason = "chose_ups_ground_saver (priority 1: UPS Ground Saver in non-express pool)";
  } else if (ug && selected?.object_id === ug?.object_id) {
    reason = "chose_ups_ground (priority 2: no Ground Saver pick; standard UPS Ground in pool)";
  } else if (cheapest && selected?.object_id === cheapest?.object_id) {
    reason = "chose_cheapest_in_pool (priority 3: non-express pool, lowest amount)";
  } else if (selected) {
    reason = "selected_matches_library_selector_compare_object_id_to_trace";
  }

  return {
    withAmountCount: withAmount.length,
    expressOrAirLikeFiltered: Math.max(0, withAmount.length - groundish.length),
    poolSize: pool.length,
    usedFallbackToAllRatedWhenExpressPoolEmpty: groundish.length === 0 && withAmount.length > 0,
    gsaverInPool: gsaver
      ? { object_id: gsaver.object_id, amount: gsaver.amount, token: getToken(gsaver), name: getName(gsaver) }
      : null,
    upsGroundInPool: ug
      ? { object_id: ug.object_id, amount: ug.amount, token: getToken(ug), name: getName(ug) }
      : null,
    cheapestInPool: cheapest
      ? { object_id: cheapest.object_id, amount: cheapest.amount, token: getToken(cheapest), name: getName(cheapest) }
      : null,
    selectedObjectId: selected?.object_id || null,
    reason,
  };
}
