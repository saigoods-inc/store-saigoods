import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedStore = null;

export function getStorePath() {
  return path.join(__dirname, "..", "data", "store.json");
}

export function loadStore() {
  if (cachedStore) {
    return cachedStore;
  }

  const filePath = getStorePath();
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  cachedStore = parsed;
  return parsed;
}

export function setCachedStore(store) {
  cachedStore = store && typeof store === "object" ? store : null;
}

export function loadBundledStore() {
  const raw = fs.readFileSync(getStorePath(), "utf8");
  return JSON.parse(raw);
}

export function getProductMap() {
  const store = loadStore();
  return new Map(store.products.map((product) => [product.slug, product]));
}

export function getKnownSizes() {
  const store = loadStore();
  return store.site.sizes;
}

/**
 * Sizes offered for this product on the storefront (and stock keys in cart/quote).
 * Falls back to `site.sizes` when `product.supportedSizes` is absent.
 * @param {object | null | undefined} product
 * @returns {string[]}
 */
export function getSupportedSizesForProduct(product) {
  const store = loadStore();
  const site = Array.isArray(store?.site?.sizes) ? store.site.sizes : [];
  const sup = product?.supportedSizes;
  if (Array.isArray(sup) && sup.length) {
    return sup.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return [...site];
}
