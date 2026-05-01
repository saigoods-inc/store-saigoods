const CART_STORAGE_KEY = "saigoods-cart-v1";
const FALLBACK_SIZES = ["S", "M", "L", "XL"];

export function getCart(sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  return Object.entries(cartMap).map(([slug, raw]) => serialiseCartItemForApi(slug, raw, sizes));
}

/**
 * Header badge: number of distinct products in the cart (one per slug), not case/box/bundle units.
 * Cart storage, checkout payloads, and pricing are unchanged.
 */
export function getCartCount(sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  return Object.keys(cartMap).length;
}

export function getQuantitiesTotal(quantities) {
  return Object.values(quantities || {}).reduce((sum, quantity) => {
    const parsed = Number(quantity);
    return sum + (Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0);
  }, 0);
}

/**
 * @param {string} slug
 * @param {{ quantities?: object, boxQuantities?: object, bundleLines?: { id: string, qty: number }[] } | object} payload
 *        Legacy: plain `{ Small: 1, ... }` case counts only.
 */
export function mergeProductQuantities(slug, payload, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const current = normaliseCartEntry(cartMap[slug], sizes);
  const addition = normaliseCartPayload(payload, sizes);
  const next = resolveMergedCartEntry(current, addition, sizes);

  if (
    getLineCases(next.quantities) + getLineCases(next.boxQuantities) === 0
  ) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = compactCartEntry(next, sizes);
  }

  writeCartMap(cartMap);
}

export function setProductQuantities(slug, payload, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const next = normaliseCartPayload(payload, sizes);

  if (
    getLineCases(next.quantities) + getLineCases(next.boxQuantities) === 0
  ) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = compactCartEntry(next, sizes);
  }

  writeCartMap(cartMap);
}

export function updateSizeQuantity(slug, size, nextQuantity, sizes = FALLBACK_SIZES) {
  updateChannelQuantity(slug, size, nextQuantity, sizes, "case");
}

export function updateBoxQuantity(slug, size, nextQuantity, sizes = FALLBACK_SIZES) {
  updateChannelQuantity(slug, size, nextQuantity, sizes, "box");
}

function updateChannelQuantity(slug, size, nextQuantity, sizes, channel) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const entry = normaliseCartEntry(cartMap[slug], sizes);
  const parsed = Number(nextQuantity);
  const q = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;

  if (channel === "box") {
    entry.boxQuantities[size] = q;
  } else {
    entry.quantities[size] = q;
  }

  entry.bundleLines = [];

  if (
    getLineCases(entry.quantities) + getLineCases(entry.boxQuantities) === 0
  ) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = compactCartEntry(entry, sizes);
  }

  writeCartMap(cartMap);
}

export function removeProduct(slug, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  delete cartMap[slug];
  writeCartMap(cartMap);
}

export function clearCart() {
  try {
    localStorage.removeItem(CART_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }

  dispatchCartUpdate();
}

function getLineCases(quantities) {
  return getQuantitiesTotal(quantities);
}

function readCartMap() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCartMap(cartMap) {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cartMap));
  } catch {
    // Ignore storage failures and still update the badge for the current page state.
  }

  dispatchCartUpdate();
}

function cleanCartMap(cartMap, sizes = FALLBACK_SIZES) {
  const nextCartMap = {};

  for (const [slug, raw] of Object.entries(cartMap || {})) {
    const entry = normaliseCartEntry(raw, sizes);

    if (
      getLineCases(entry.quantities) + getLineCases(entry.boxQuantities) >
      0
    ) {
      nextCartMap[slug] = compactCartEntry(entry, sizes);
    }
  }

  return nextCartMap;
}

function normaliseCartEntry(raw, sizes = FALLBACK_SIZES) {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.hasOwn(raw, "quantities")
  ) {
    return {
      quantities: sanitiseQuantities(raw.quantities, sizes),
      boxQuantities: sanitiseQuantities(raw.boxQuantities, sizes),
      bundleLines: sanitiseBundleLines(raw.bundleLines),
    };
  }

  return {
    quantities: sanitiseQuantities(raw, sizes),
    boxQuantities: sizes.reduce((acc, size) => {
      acc[size] = 0;
      return acc;
    }, {}),
    bundleLines: [],
  };
}

function normaliseCartPayload(payload, sizes) {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, "quantities")
  ) {
    return {
      quantities: sanitiseQuantities(payload.quantities, sizes),
      boxQuantities: sanitiseQuantities(payload.boxQuantities, sizes),
      bundleLines: sanitiseBundleLines(payload.bundleLines),
    };
  }

  return {
    quantities: sanitiseQuantities(payload, sizes),
    boxQuantities: sizes.reduce((acc, size) => {
      acc[size] = 0;
      return acc;
    }, {}),
    bundleLines: [],
  };
}

function sanitiseQuantities(quantities, sizes = FALLBACK_SIZES) {
  return sizes.reduce((result, size) => {
    const rawValue =
      quantities && Object.hasOwn(quantities, size) ? quantities[size] : 0;
    const parsed = Number(rawValue);
    result[size] = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    return result;
  }, {});
}

function sanitiseBundleLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines
    .map((line) => ({
      id: String(line?.id || "").trim(),
      qty: Math.floor(Number(line?.qty) || 0),
    }))
    .filter((line) => line.id && line.qty > 0);
}

function mergeCartEntries(a, b, sizes) {
  const quantities = sizes.reduce((acc, size) => {
    acc[size] = (a.quantities[size] || 0) + (b.quantities[size] || 0);
    return acc;
  }, {});
  const boxQuantities = sizes.reduce((acc, size) => {
    acc[size] = (a.boxQuantities[size] || 0) + (b.boxQuantities[size] || 0);
    return acc;
  }, {});
  const bundleLines = mergeBundleLineArrays(a.bundleLines, b.bundleLines);
  return { quantities, boxQuantities, bundleLines };
}

function cloneCartEntry(entry) {
  return {
    quantities: { ...entry.quantities },
    boxQuantities: { ...entry.boxQuantities },
    bundleLines: entry.bundleLines.map((line) => ({ ...line })),
  };
}

/**
 * Bundle PDP lines must not be merged with legacy “cases only” rows: summed quantities would
 * break `bundleLines` vs size totals on the server. Rules:
 * - Addition has bundle lines, existing does not → replace with addition (fresh PDP snapshot).
 * - Addition is legacy, existing has bundle lines → drop bundle pricing, then sum quantities.
 * - Both bundle or both legacy → normal merge.
 */
function resolveMergedCartEntry(current, addition, sizes) {
  const addBundles = addition.bundleLines.length > 0;
  const curBundles = current.bundleLines.length > 0;

  if (addBundles && !curBundles) {
    return cloneCartEntry(addition);
  }

  if (!addBundles && curBundles) {
    const stripped = { ...current, bundleLines: [] };
    return mergeCartEntries(stripped, addition, sizes);
  }

  return mergeCartEntries(current, addition, sizes);
}

function mergeBundleLineArrays(a, b) {
  const map = new Map();

  for (const arr of [a, b]) {
    for (const { id, qty } of arr || []) {
      if (!id || qty < 1) {
        continue;
      }
      map.set(id, (map.get(id) || 0) + qty);
    }
  }

  return [...map.entries()].map(([id, qty]) => ({ id, qty }));
}

function compactCartEntry(entry, sizes) {
  const hasBoxes = sizes.some((size) => entry.boxQuantities[size] > 0);
  const hasBundles = entry.bundleLines.length > 0;

  if (!hasBoxes && !hasBundles) {
    return entry.quantities;
  }

  return {
    quantities: entry.quantities,
    boxQuantities: entry.boxQuantities,
    bundleLines: entry.bundleLines,
  };
}

function serialiseCartItemForApi(slug, raw, sizes) {
  const entry = normaliseCartEntry(raw, sizes);
  const item = {
    slug,
    quantities: entry.quantities,
    boxQuantities: entry.boxQuantities,
  };
  if (entry.bundleLines.length) {
    item.bundleLines = entry.bundleLines;
  }
  return item;
}

function dispatchCartUpdate() {
  window.dispatchEvent(
    new CustomEvent("cart:updated", {
      detail: { count: getCartCount() },
    }),
  );
}
