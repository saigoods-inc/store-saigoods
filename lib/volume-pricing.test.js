import test from "node:test";
import assert from "node:assert/strict";

import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { computeEconomicsSnapshotForOrder } from "./order-economics.js";
import { buildQuote } from "./quote.js";
import { loadBundledStore, setCachedStore } from "./store.js";

async function withVolumeProduct(run, rule = {}) {
  const store = loadBundledStore();
  const product = store.products.find((candidate) => candidate.slug === "black-nitrile-general");
  product.volumePricing = {
    active: true,
    minCases: 3,
    pricePerCaseCents: 5000,
    allowDiscountStacking: false,
    ...rule,
  };
  setCachedStore(store);
  try {
    return await run(product);
  } finally {
    setCachedStore(loadBundledStore());
  }
}

function caseItems(bundleLines, quantities = { M: 2, L: 1 }) {
  return [{
    slug: "black-nitrile-general",
    bundleLines,
    quantities,
    boxQuantities: { M: 0, L: 0 },
  }];
}

test("volume price activates across sizes at the configured carton threshold", async () => {
  await withVolumeProduct(() => {
    const quote = buildQuote(caseItems([{ id: "case_1", qty: 3 }]), { omitShippingEstimate: true });
    assert.equal(quote.subtotalCents, 15000);
    assert.equal(quote.volumePricingApplied, true);
    assert.equal(quote.items[0].volumePricing.caseCount, 3);
    assert.equal(quote.items[0].volumePricing.minCases, 3);
    assert.equal(quote.items[0].volumePricing.pricePerCaseCents, 5000);
    assert.equal(quote.items[0].volumePricing.savingsCents, 3 * (5799 - 5000));
  });
});

test("volume price leaves boxes unchanged and counts multi-carton bundles", async () => {
  await withVolumeProduct((product) => {
    product.bundles = [
      ...product.bundles,
      { id: "case_3", label: "3 cartons", kind: "case", units: 3, priceCents: 17000, active: true },
    ];
    const items = [{
      slug: product.slug,
      bundleLines: [{ id: "case_3", qty: 1 }, { id: "box_1", qty: 2 }],
      quantities: { M: 3, L: 0 },
      boxQuantities: { M: 0, L: 2 },
    }];
    const quote = buildQuote(items, { omitShippingEstimate: true });
    assert.equal(quote.subtotalCents, 15000 + 2 * 899);
    assert.equal(quote.items[0].volumePricing.caseCount, 3);
  });
});

test("orders snapshot both volume and later manual discount loss against list pricing", async () => {
  await withVolumeProduct(async () => {
    const items = caseItems([{ id: "case_1", qty: 3 }]);
    const quote = await buildFullCheckoutQuote(items, {}, {
      receiptRebuild: true,
      manualDiscount: { type: "percent", value: 10 },
    });
    assert.equal(quote.subtotalCents, 13500);
  }, { allowDiscountStacking: true });

  await withVolumeProduct(async () => {
    const items = caseItems([{ id: "case_1", qty: 3 }]);
    const quote = buildQuote(items, { omitShippingEstimate: true });
    const snapshot = computeEconomicsSnapshotForOrder(items, quote);
    assert.equal(snapshot.merchandise_list_subtotal_cents, 3 * 5799);
    assert.equal(snapshot.merchandise_discount_loss_cents, 3 * (5799 - 5000));
    assert.equal(quote.items[0].volumePricing.pricePerCaseCents, 5000);
  });
});

test("non-stacking volume rules reject an additional discount", async () => {
  await withVolumeProduct(async () => {
    await assert.rejects(
      buildFullCheckoutQuote(caseItems([{ id: "case_1", qty: 3 }]), {}, {
        receiptRebuild: true,
        manualDiscount: { type: "percent", value: 10 },
      }),
      /cannot be combined/i,
    );
  });
});
