const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

let storePromise;

export async function getStore() {
  if (!storePromise) {
    storePromise = requestJson("/api/products");
  }

  return storePromise;
}

export async function getProduct(slug) {
  const store = await getStore();
  return store.products.find((product) => product.slug === slug) || null;
}

/**
 * Sizes shown and allocated on the PDP for one product (subset when `supportedSizes` is set).
 * @param {object | null | undefined} product
 * @param {{ site?: { sizes?: string[] } }} store
 */
export function storefrontSizesForProduct(product, store) {
  const site = Array.isArray(store?.site?.sizes) ? store.site.sizes : [];
  if (!product || typeof product !== "object") {
    return [...site];
  }
  const sup = product.supportedSizes;
  if (Array.isArray(sup) && sup.length) {
    return sup.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return [...site];
}

export function searchProducts(products, query) {
  const terms = normaliseQuery(query);

  if (!terms.length) {
    return products;
  }

  return products.filter((product) => {
    const searchField = [
      product.name,
      product.shortName,
      product.subtext,
      product.description,
      ...(product.keywords || []),
      ...(product.specs || []).flatMap((spec) => [spec.label, spec.value]),
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => searchField.includes(term));
  });
}

export function formatCurrency(cents) {
  return currencyFormatter.format(Number(cents || 0) / 100);
}

/**
 * Bundle card: per-box or per-case line (below title + total wrapper).
 * @param {number} priceCents
 * @param {number} units
 * @param {string} kind — "box" | "case"
 */
export function bundleCardPricePerHtml(priceCents, units, kind) {
  const u = Math.max(1, Math.floor(Number(units) || 0));
  const perCents = Math.round(Number(priceCents) / u);
  const k = String(kind || "").toLowerCase();
  const suffix = k === "box" ? "/box" : "/case";
  return `<div class="bundle-card__price-row"><span class="bundle-card__price-per">${formatCurrency(
    perCents,
  )}${suffix}</span></div>`;
}

export function formatCaseLabel(count) {
  return `${count} case${count === 1 ? "" : "s"}`;
}

export function formatSizeDisplayLabel(size) {
  const raw = String(size || "").trim().toUpperCase();
  if (raw === "S") return "Small";
  if (raw === "M") return "Medium";
  if (raw === "L") return "Large";
  if (raw === "XL" || raw === "X LARGE" || raw === "X-LARGE") return "XLarge";
  return String(size || "").trim();
}

/**
 * One size row: "Small: 3 cases 2 boxes" (omits zero parts).
 * @returns {string|null}
 */
export function formatSizeLineText(size, quantities, boxQuantities) {
  const c = Math.floor(Number(quantities?.[size]) || 0);
  const b = Math.floor(Number(boxQuantities?.[size]) || 0);
  if (c < 1 && b < 1) {
    return null;
  }
  const parts = [];
  if (c > 0) {
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (b > 0) {
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return `${formatSizeDisplayLabel(size)}: ${parts.join(" ")}`;
}

/** Cart / quote line: cases and/or boxes. */
export function formatCartUnitLabel(item) {
  const c = Math.floor(Number(item?.lineCases) || 0);
  const b = Math.floor(Number(item?.lineBoxCount) || 0);
  const parts = [];
  if (c > 0) {
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (b > 0) {
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(" · ") : "0 items";
}

export function getCartQuote(items) {
  return requestJson("/api/cart/quote", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

export function createCheckout(items, customer = {}) {
  return requestJson("/api/checkout", {
    method: "POST",
    body: JSON.stringify({ items, customer: customer || {} }),
  });
}

export function normaliseQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "Unexpected server response." };
  }

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}
