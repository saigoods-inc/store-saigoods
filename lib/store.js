import fs from "node:fs";
import path from "node:path";

let cachedStore = null;

export function getStorePath() {
  const projectRoot = process.cwd();
  return path.join(projectRoot, "data", "store.json");
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

export function getProductMap() {
  const store = loadStore();
  return new Map(store.products.map((product) => [product.slug, product]));
}

export function getKnownSizes() {
  const store = loadStore();
  return store.site.sizes;
}

