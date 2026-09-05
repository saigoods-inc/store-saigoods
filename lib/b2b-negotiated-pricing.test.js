import assert from "node:assert/strict";
import test from "node:test";

import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { computeEconomicsSnapshotForOrder } from "./order-economics.js";

const address = { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" };

function negotiatedBox(overrides = {}) {
  return {
    slug: "nitrile-standard",
    clientLineId: "b2b-line-1",
    bundleLines: [{ id: "box_1", qty: 2 }],
    quantities: { S: 0, M: 0, L: 0 },
    boxQuantities: { S: 0, M: 2, L: 0 },
    b2bNegotiatedUnitPriceCents: 850,
    b2bNegotiationReason: "Approved contract price",
    ...overrides,
  };
}

test("admin B2B negotiated price is authoritative for merchandise, tax, and total", async () => {
  const items = [negotiatedBox()];
  const quote = await buildFullCheckoutQuote(items, address, {
    flow: "admin_manual",
    manualShippingAmountCents: 2500,
    allowB2BNegotiatedPricing: true,
  });
  assert.equal(quote.subtotalCents, 1700);
  assert.equal(quote.shippingCents, 2500);
  assert.equal(quote.taxCents, 410);
  assert.equal(quote.totalCents, 4610);
  assert.deepEqual(quote.items[0].b2bPricing, {
    mode: "negotiated",
    unitPriceCents: 850,
    unitPriceFormatted: "$8.50",
    catalogUnitPriceCents: 899,
    catalogUnitPriceFormatted: "$8.99",
    quantity: 2,
    adjustmentCents: -98,
    reason: "Approved contract price",
    profitSnapshotUsesCatalogBaseline: true,
  });
  assert.deepEqual(quote.items[0].adminPriceOverride, quote.items[0].b2bPricing);
  const economics = computeEconomicsSnapshotForOrder(items, quote);
  assert.equal(economics.merchandise_list_subtotal_cents, 1798);
  assert.equal(economics.merchandise_discount_loss_cents, 98);
  assert.equal(economics.expected_profit_cents, 226);
});

test("custom price fields are rejected outside the authorized admin path", async () => {
  await assert.rejects(
    buildFullCheckoutQuote([negotiatedBox()], address, { flow: "admin_manual", manualShippingAmountCents: 2500 }),
    /only available for authorized admin orders/i,
  );
});

test("admin selling-price override works for a non-B2B manual order", async () => {
  const items = [negotiatedBox({
    b2bNegotiatedUnitPriceCents: undefined,
    b2bNegotiationReason: undefined,
    adminUnitPriceOverrideCents: 875,
    adminPriceOverrideReason: "Manager-approved customer price",
  })];
  const quote = await buildFullCheckoutQuote(items, address, {
    flow: "admin_manual",
    manualShippingAmountCents: 2500,
    allowB2BNegotiatedPricing: true,
  });
  assert.equal(quote.subtotalCents, 1750);
  assert.equal(quote.items[0].adminPriceOverride.catalogUnitPriceCents, 899);
  assert.equal(quote.items[0].adminPriceOverride.unitPriceCents, 875);
  assert.equal(quote.items[0].adminPriceOverride.adjustmentCents, -48);
});

test("admin selling-price override does not require a reason", async () => {
  const quote = await buildFullCheckoutQuote([negotiatedBox({
    b2bNegotiatedUnitPriceCents: undefined,
    b2bNegotiationReason: undefined,
    adminUnitPriceOverrideCents: 875,
    adminPriceOverrideReason: "",
  })], address, {
    flow: "admin_manual",
    manualShippingAmountCents: 2500,
    allowB2BNegotiatedPricing: true,
  });
  assert.equal(quote.items[0].adminPriceOverride.unitPriceCents, 875);
  assert.equal(quote.items[0].adminPriceOverride.reason, "");
});

test("custom selling prices cannot stack with another discount", async () => {
  await assert.rejects(
    buildFullCheckoutQuote([negotiatedBox()], address, {
      flow: "admin_manual",
      manualShippingAmountCents: 2500,
      allowB2BNegotiatedPricing: true,
      manualDiscount: { type: "percent", value: 5 },
    }),
    /cannot be combined with another discount/i,
  );
});

test("custom selling prices accept an explicit no-discount selection", async () => {
  const quote = await buildFullCheckoutQuote([negotiatedBox()], address, {
    flow: "admin_manual",
    manualShippingAmountCents: 2500,
    allowB2BNegotiatedPricing: true,
    manualDiscount: { type: "none", value: 0 },
  });
  assert.equal(quote.subtotalCents, 1700);
  assert.equal(quote.discountCents ?? 0, 0);
  assert.equal(quote.totalCents, 4610);
});

test("negotiated B2B prices cannot go below product cost", async () => {
  await assert.rejects(
    buildFullCheckoutQuote([negotiatedBox({ b2bNegotiatedUnitPriceCents: 700 })], address, {
      flow: "admin_manual",
      manualShippingAmountCents: 2500,
      allowB2BNegotiatedPricing: true,
    }),
    /cannot be below cost/i,
  );
});
