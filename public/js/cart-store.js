const CART_STORAGE_KEY = "saigoods-cart-v1";
const FALLBACK_SIZES = ["Small", "Medium", "Large", "X Large"];

export function getCart(sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  return Object.entries(cartMap).map(([slug, quantities]) => ({
    slug,
    quantities,
  }));
}

export function getCartCount() {
  const cartMap = readCartMap();

  return Object.values(cartMap).reduce((sum, quantities) => {
    return (
      sum +
      Object.values(quantities || {}).reduce((lineSum, quantity) => {
        const parsed = Number(quantity);
        return lineSum + (Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0);
      }, 0)
    );
  }, 0);
}

export function getQuantitiesTotal(quantities) {
  return Object.values(quantities || {}).reduce((sum, quantity) => {
    const parsed = Number(quantity);
    return sum + (Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0);
  }, 0);
}

export function mergeProductQuantities(slug, additions, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const current = sanitiseQuantities(cartMap[slug], sizes);
  const next = sanitiseQuantities(additions, sizes);

  for (const size of sizes) {
    current[size] += next[size];
  }

  if (getQuantitiesTotal(current) === 0) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = current;
  }

  writeCartMap(cartMap);
}

export function setProductQuantities(slug, quantities, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const next = sanitiseQuantities(quantities, sizes);

  if (getQuantitiesTotal(next) === 0) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = next;
  }

  writeCartMap(cartMap);
}

export function updateSizeQuantity(slug, size, nextQuantity, sizes = FALLBACK_SIZES) {
  const cartMap = cleanCartMap(readCartMap(), sizes);
  const quantities = sanitiseQuantities(cartMap[slug], sizes);
  const parsed = Number(nextQuantity);
  quantities[size] = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;

  if (getQuantitiesTotal(quantities) === 0) {
    delete cartMap[slug];
  } else {
    cartMap[slug] = quantities;
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

  for (const [slug, quantities] of Object.entries(cartMap || {})) {
    const cleanQuantities = sanitiseQuantities(quantities, sizes);

    if (getQuantitiesTotal(cleanQuantities) > 0) {
      nextCartMap[slug] = cleanQuantities;
    }
  }

  return nextCartMap;
}

function sanitiseQuantities(quantities, sizes = FALLBACK_SIZES) {
  return sizes.reduce((result, size) => {
    const rawValue = quantities && Object.hasOwn(quantities, size) ? quantities[size] : 0;
    const parsed = Number(rawValue);
    result[size] = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    return result;
  }, {});
}

function dispatchCartUpdate() {
  window.dispatchEvent(
    new CustomEvent("cart:updated", {
      detail: { count: getCartCount() },
    }),
  );
}
