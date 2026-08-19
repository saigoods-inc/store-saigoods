import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { __classifyMarketplaceRpcErrorForTests, marketplaceFinancialContribution, normaliseMarketplaceOrderInput } from "./marketplace-orders.js";

const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ordersPageSource = readFileSync(new URL("../admin-v2.5/src/pages/OrdersPage.tsx", import.meta.url), "utf8");

test("local server dispatches marketplace order reads and writes to the API handler", () => {
  assert.match(serverSource, /import adminMarketplaceOrdersHandler from "\.\/api\/admin-marketplace-orders\.js"/);
  assert.match(serverSource, /pathname === "\/api\/admin-marketplace-orders" && \(req\.method === "GET" \|\| req\.method === "POST"\)/);
  assert.match(serverSource, /await adminMarketplaceOrdersHandler\(/);
  assert.match(serverSource, /req\.method === "POST" \? await readJsonBody\(req\) : undefined/);
});

test("marketplace order modal keeps required cues, ordered sizes, and annotated controls", () => {
  assert.match(ordersPageSource, /\["S", "M", "L", "XL"\]/);
  assert.match(ordersPageSource, /\.sort\(compareMarketplaceSizes\)/);
  assert.match(ordersPageSource, /aria-label="Close"><Icon name="x" className="h-4 w-4"/);
  assert.match(ordersPageSource, /Notes <textarea className="sg25-input mt-1 min-h-20 w-full p-\[7px\]"/);
  assert.match(ordersPageSource, /Marketplace <span className="text-sg-danger" aria-hidden="true">\*<\/span>/);
  assert.match(ordersPageSource, /Quantity <span className="text-sg-danger" aria-hidden="true">\*<\/span>/);
});

test("marketplace order input accepts Amazon FBM and Walmart seller-fulfilled lines", () => {
  const input = normaliseMarketplaceOrderInput({
    marketplace: "Amazon",
    externalOrderId: "AMZ-123",
    lines: [{ productSlug: "nitrile-standard", size: "M", quantityCases: 1, unitSalePriceCents: 6500 }],
    shippingChargedCents: 0,
    marketplaceFeeCents: 975,
    shippingCostCents: 825,
  });

  assert.equal(input.marketplace, "amazon");
  assert.equal(input.externalOrderId, "AMZ-123");
  assert.equal(input.lines[0].unitType, "case");
  assert.equal(input.lines[0].lineRevenueCents, 6500);
  assert.equal(input.lines[0].lineCostCents, 4705);
  assert.equal(input.financials.marketplaceFeeCents, 975);
  assert.equal(input.financials.shippingCostCents, 825);
  assert.equal(input.financials.financialStatus, "complete");
});

test("marketplace order input rejects incomplete lines and unsupported channels", () => {
  assert.throws(
    () => normaliseMarketplaceOrderInput({ marketplace: "ebay", externalOrderId: "1", lines: [{ productSlug: "x", size: "M", quantityBoxes: 1 }] }),
    /Amazon or Walmart/i,
  );
  assert.throws(
    () => normaliseMarketplaceOrderInput({ marketplace: "walmart", externalOrderId: "1", lines: [{ productSlug: "x", size: "M" }] }),
    /product, size, and quantity/i,
  );
});

test("marketplace financial contribution excludes tax and uses frozen line cost", () => {
  const result = marketplaceFinancialContribution({
    merchandise_subtotal_cents: 13000,
    shipping_charged_cents: 500,
    discount_cents: 1000,
    tax_collected_cents: 975,
    marketplace_fee_cents: 1800,
    payment_processing_fee_cents: 200,
    shipping_cost_cents: 900,
    other_cost_cents: 100,
    refund_cents: 0,
    lines: [{ line_cost_cents: 9400 }],
  });
  assert.equal(result.revenueCents, 12500);
  assert.equal(result.currentProfitCents, 100);
  assert.equal(result.shippingProfitCents, -400);
});

test("marketplace migration deducts stock when recorded and restores it only when cancelled", () => {
  const migration = readFileSync(new URL("../sql/patch-marketplace-orders.sql", import.meta.url), "utf8");
  const recordIndex = migration.indexOf("create or replace function public.marketplace_order_record");
  const recordCommitIndex = migration.indexOf("perform public.inventory_consume_demands(v_ops)", recordIndex);
  const transitionIndex = migration.indexOf("create or replace function public.marketplace_order_transition");
  const cancelIndex = migration.indexOf("if desired = 'cancelled'", transitionIndex);
  const transitionBody = migration.slice(transitionIndex);

  assert.ok(recordCommitIndex > recordIndex);
  assert.ok(cancelIndex > transitionIndex);
  assert.match(migration, /movement_type = 'marketplace_sale'/);
  assert.match(migration, /'cases_delta', -movement\.cases_delta/);
  assert.match(migration, /'boxes_delta', -movement\.boxes_delta/);
  assert.equal(transitionBody.includes("if desired = 'shipped' then\n    for line"), false);
  assert.match(migration, /if o\.status = 'shipped'.*desired = 'shipped'/s);
  assert.match(migration, /notify pgrst, 'reload schema';/);
  assert.match(migration, /merchandise_subtotal_cents/);
  assert.match(migration, /unit_sale_price_cents/);
  assert.match(migration, /financial_status/);
});

test("marketplace storage failures are converted to an actionable setup message", () => {
  const source = readFileSync(new URL("./marketplace-orders.js", import.meta.url), "utf8");
  assert.match(source, /PGRST20\[25\]\|schema cache\|marketplace_order_record/);
  assert.match(source, /Marketplace order storage is not set up yet\. Apply the marketplace database migration, then try again\./);
  assert.match(source, /statusCode: 503/);
});

test("marketplace negative-stock RPC failures identify the selected product and size", () => {
  const result = __classifyMarketplaceRpcErrorForTests(
    "negative stock for variant 5e8dacc7-af2f-4379-830a-b689449922be (cases 193 -> 193, boxes 1 -> -1)",
    { lines: [{ productSlug: "nitrile-standard", size: "M", quantityCases: 0, quantityBoxes: 2 }] },
  );
  assert.equal(result.statusCode, 409);
  assert.equal(result.message, "Not enough stock for nitrile-standard / M: 1 box available, 2 requested. Reduce the quantity or update inventory, then try again.");
  assert.doesNotMatch(result.message, /5e8dacc7/);
});

test("marketplace shared-stock failures report carton-converted box availability", () => {
  const result = __classifyMarketplaceRpcErrorForTests(
    "insufficient stock for variant 5e8dacc7-af2f-4379-830a-b689449922be (cases 1, boxes 1, boxes_per_case 10, requested_cases 0, requested_boxes 12)",
    { lines: [{ productSlug: "nitrile-standard", size: "M", quantityCases: 0, quantityBoxes: 12 }] },
  );
  assert.equal(result.statusCode, 409);
  assert.equal(result.message, "Not enough stock for nitrile-standard / M: 11 boxes available after carton items, 12 requested.");
  assert.doesNotMatch(result.message, /5e8dacc7/);
});

test("marketplace modal shows availability and blocks an over-stock submission before POST", () => {
  assert.match(ordersPageSource, /availableLabel/);
  assert.match(ordersPageSource, /requestedByVariant/);
  assert.match(ordersPageSource, /boxesAfterCartons/);
  assert.match(ordersPageSource, /availableBoxesEquivalent/);
  assert.match(ordersPageSource, /intact cartons/);
});

test("marketplace admin captures actual sale price and seller-portal costs", () => {
  assert.match(ordersPageSource, /Selling price \/ unit/);
  assert.match(ordersPageSource, /Marketplace financials/);
  assert.match(ordersPageSource, /Marketplace fees and shipping cost are required/);
  assert.match(ordersPageSource, /filteredOrders\.slice\(effectiveOrderPage \* 10, effectiveOrderPage \* 10 \+ 10\)/);
});
