import test from "node:test";
import assert from "node:assert/strict";

import {
  bundleCatalogFromStore,
  findUnknownRuntimeBundleSelections,
  mergeBundleCatalogIntoStore,
} from "./runtime-store.js";
import { loadBundledStore, setCachedStore } from "./store.js";
import { assertCartItemsHaveValidSupportedSizeAllocation, buildQuote } from "./quote.js";
import { computeEconomicsSnapshotForOrder } from "./order-economics.js";

test("runtime bundle catalog replaces only bundle definitions", () => {
  const store = {
    site: { name: "Store" },
    products: [{ slug: "a", name: "A", priceCents: 100, bundles: [{ id: "old" }] }],
  };
  const catalog = bundleCatalogFromStore(store);
  catalog.products[0].bundles = [{ id: "case_3", label: "3 cartons", kind: "case", units: 3, priceCents: 250 }];
  catalog.products[0].volumePricing = { active: true, minCases: 3, pricePerCaseCents: 80, allowDiscountStacking: false };
  const merged = mergeBundleCatalogIntoStore(store, catalog);
  assert.equal(merged.products[0].priceCents, 100);
  assert.deepEqual(merged.products[0].bundles, catalog.products[0].bundles);
  assert.deepEqual(merged.products[0].volumePricing, catalog.products[0].volumePricing);
  assert.deepEqual(store.products[0].bundles, [{ id: "old" }]);
});

test("runtime bundle selection check accepts newly configured bundle IDs", () => {
  const store = loadBundledStore();
  const catalog = bundleCatalogFromStore(store);
  catalog.products[0].bundles.push({
    id: "5_boxes",
    label: "5 boxes",
    kind: "box",
    units: 5,
    priceCents: 4495,
    active: true,
  });
  const runtimeStore = mergeBundleCatalogIntoStore(store, catalog);
  assert.deepEqual(
    findUnknownRuntimeBundleSelections(runtimeStore, [
      {
        slug: catalog.products[0].slug,
        bundleLines: [{ id: "5_boxes", qty: 1 }],
      },
    ]),
    [],
  );
});

test("runtime bundle selection check identifies a stale catalog by exact product and ID", () => {
  const store = loadBundledStore();
  assert.deepEqual(
    findUnknownRuntimeBundleSelections(store, [
      {
        slug: store.products[0].slug,
        bundleLines: [{ id: "5_boxes", qty: 1 }],
      },
    ]),
    [{ slug: store.products[0].slug, id: "5_boxes" }],
  );
});

test("a future multi-carton bundle prices one bundle and validates all physical cartons", () => {
  const store = loadBundledStore();
  const product = store.products.find((candidate) => candidate.slug === "nitrile-standard");
  product.bundles = [...product.bundles, { id: "case_3", label: "3 cartons", kind: "case", units: 3, priceCents: 14999 }];
  setCachedStore(store);
  const items = [{
    slug: "nitrile-standard",
    bundleLines: [{ id: "case_3", qty: 1 }],
    quantities: { S: 0, M: 3, L: 0 },
    boxQuantities: { S: 0, M: 0, L: 0 },
  }];
  try {
    assert.doesNotThrow(() => assertCartItemsHaveValidSupportedSizeAllocation(items));
    const quote = buildQuote(items, { omitShippingEstimate: true });
    assert.equal(quote.items[0].lineCases, 3);
    assert.equal(quote.items[0].lineTotalCents, 14999);
  } finally {
    setCachedStore(loadBundledStore());
  }
});

test("a newly configured 5-box bundle survives the order economics snapshot", () => {
  const store = loadBundledStore();
  const product = store.products.find((candidate) => candidate.slug === "nitrile-standard");
  product.bundles = [
    ...product.bundles,
    { id: "5_boxes", label: "5 boxes", kind: "box", units: 5, priceCents: 4495, active: true },
  ];
  setCachedStore(store);
  const items = [{
    slug: "nitrile-standard",
    bundleLines: [{ id: "5_boxes", qty: 1 }],
    quantities: { S: 0, M: 0, L: 0 },
    boxQuantities: { S: 0, M: 5, L: 0 },
  }];

  try {
    const quote = buildQuote(items, { omitShippingEstimate: true });
    const snapshot = computeEconomicsSnapshotForOrder(items, quote);
    assert.equal(quote.subtotalCents, 4495);
    assert.equal(snapshot.merchandise_list_subtotal_cents, 4495);
  } finally {
    setCachedStore(loadBundledStore());
  }
});
