import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

test("Advanced bundle pricing follows box-to-carton hierarchy", () => {
  const source = read("admin-app/src/pages/AdvancedPage.tsx");

  assert.match(source, /function compareBundleHierarchy/);
  assert.match(source, /a\.kind === "case" \? 1 : 0/);
  assert.match(source, /a\.units - b\.units/);
  assert.match(source, /\.sort\(compareBundleHierarchy\)/);
});

test("Admin Advanced page uses a browser-session access gate", () => {
  const app = read("admin-app/src/App.tsx");
  const shell = read("admin-app/src/components/layout/AdminShell.tsx");

  assert.match(app, /ADVANCED_ACCESS_SESSION_KEY/);
  assert.match(app, /window\.sessionStorage\.getItem\(ADVANCED_ACCESS_SESSION_KEY\)/);
  assert.match(app, /window\.sessionStorage\.setItem\(ADVANCED_ACCESS_SESSION_KEY, "granted"\)/);
  assert.match(app, /const ADVANCED_ACCESS_PASSWORD = "Saigoods2025#"/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /aria-modal="true"/);
  assert.match(app, /path="\/advanced" element=\{<AdvancedAccessGate \/>\}/);
  assert.doesNotMatch(shell, /Legacy admin-v2/);
  assert.doesNotMatch(shell, /href="\/admin-v2\/summary"/);
});

test("Order Builder treats the selected carrier rate as an editable draft until creation", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");

  assert.match(source, /const nextSelected = isSelected \? "" : id/);
  assert.match(source, /setSelectedRateId\(nextSelected\)/);
  assert.match(source, /setSelectedRateSnapshot\(nextSelected \? rate : null\)/);
  assert.match(source, /rateAmountCents\(selectedRateSnapshot\)/);
  assert.match(source, /errors\.carrierRate = "Select a carrier rate before creating the order\."/);
  assert.match(source, /await createManualOrder\(request, token\)/);
  assert.match(source, /await updateManualOrderDraft\(\{ \.\.\.request, orderId: editOrderId \}, token\)/);
  assert.match(source, /status\.message === quote\.userFacingError/);
  assert.match(source, /md:grid-cols-3/);
  assert.match(source, /Build the order one product line at a time/);
  assert.doesNotMatch(source, /Confirm rate|Rate confirmed|Confirming rate|selectedRateConfirmed|confirmedRateId/);
});

test("expired manual payment links offer unchanged resend or quote-recalculating edit", () => {
  const orders = read("admin-app/src/pages/OrdersPage.tsx");
  const builder = read("admin-app/src/pages/OrderBuilderPage.tsx");
  const prepare = read("api/admin-manual-order-prepare-edit.js");

  assert.match(orders, /label: "Expired"/);
  assert.match(orders, /Send new payment link/);
  assert.match(orders, /Edit order first/);
  assert.match(orders, /prepareManualOrderEdit\(orderId, token\)/);
  assert.match(builder, /fetchManualOrderDraft\(editOrderId, token\)/);
  assert.match(builder, /Save changes and send new link/);
  assert.match(builder, /setQuoteDirty\(true\)/);
  assert.match(prepare, /deletePaymentLink\(paymentLinkId\)/);
  assert.match(prepare, /resetExpiredManualPaymentLink\(order\.id\)/);
});

test("Order Builder product controls stay unclipped and use polished select and quantity controls", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");
  const select = read("admin-app/src/components/ui/CustomSelect.tsx");

  assert.doesNotMatch(source, /<article key=\{row\.id\} className=\{`relative overflow-hidden/);
  assert.match(source, /p-4 pl-5/);
  assert.match(source, /bottom-2 left-2 top-2 w-0\.5 overflow-hidden rounded-full/);
  assert.match(source, /bg-sg-input-bg\/60 px-3\.5 text-\[12px\] font-semibold/);
  assert.match(source, /<output aria-live="polite"/);
  assert.match(source, /rounded-full border border-sg-border bg-white/);
  assert.match(select, /z-50/);
  assert.match(select, /<Icon name="check"/);
  assert.match(source, /useState<OrderItemRow\[\]>\(\[\]\)/);
  assert.match(source, /setItemRows\(\(current\) => current\.filter\(\(row\) => row\.id !== itemId\)\)/);
  assert.match(source, /itemRows\.length \? "Add another item" : "Add item"/);
  assert.match(source, /sm:grid-cols-2 2xl:grid-cols-\[minmax\(220px,1\.6fr\)/);
  assert.doesNotMatch(source, /sm:grid-cols-2 xl:grid-cols-\[minmax\(220px,1\.6fr\)/);
});

test("Order Builder exposes an admin selling-price override without changing the catalog", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");
  const api = read("admin-app/src/lib/api.ts");

  assert.match(source, />Selling price</);
  assert.match(source, /"Catalog price" : "Custom price"/);
  assert.match(source, /label="Custom unit price"/);
  assert.match(source, /label="Reason for price change"/);
  assert.match(source, /prefix="\$"/);
  assert.match(source, /adminUnitPriceOverrideCents: parseDollarsToCents/);
  assert.match(source, /adminPriceOverrideReason: row\.negotiationReason\.trim\(\)/);
  assert.doesNotMatch(source, /fulfillmentMethod === "b2b_shipping" \? \(\s*<div className="mt-3 rounded-\[10px\]/);
  assert.match(api, /adminUnitPriceOverrideCents\?: number/);
  assert.match(api, /adminPriceOverrideReason\?: string/);
});

test("Order Builder uses compact fulfillment choices and disables sticky summary when it grows too tall", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");

  assert.match(source, /aria-label=\{`Remove item \$\{index \+ 1\}`\}/);
  assert.match(source, /<Icon name="trash"/);
  assert.doesNotMatch(source, /Quote Shippo\/UPS rates from the customer address\./);
  assert.doesNotMatch(source, /Collect details only when the route needs them\./);
  assert.doesNotMatch(source, /Custom route or large-truck freight cost\./);
  assert.match(source, /new ResizeObserver\(updateStickyEligibility\)/);
  assert.match(source, /summary\.getBoundingClientRect\(\)\.height <= availableHeight/);
  assert.match(source, /data-sticky-enabled=\{summaryCanStick \? "true" : "false"\}/);
  assert.match(source, /summaryCanStick \? "lg:sticky lg:top-\[88px\]" : "lg:static"/);
});

test("Order Builder discount controls separate discount types from percentage values", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");

  assert.match(source, /aria-label="Discount type"/);
  assert.match(source, /No discount/);
  assert.match(source, /Discount code/);
  assert.match(source, /Fixed amount/);
  assert.match(source, /aria-label="Percentage discount"/);
  assert.match(source, /quickPercentOptions/);
  assert.match(source, /discountCategoryForMode/);
  assert.match(source, /setDiscountMode\(option\.value === "percent" \? "percent_5"/);
  assert.match(source, /discountMode === "code"[\s\S]*?className="mt-4 w-full rounded-\[9px\]/);
  assert.match(source, /discountMode === "custom_amount"[\s\S]*?className="mt-4 w-full rounded-\[9px\]/);
});

test("cancelled order drawer can send a notification-only refund email", () => {
  const source = read("admin-app/src/pages/OrdersPage.tsx");
  const api = read("api/admin-order-cancellation-email.js");

  assert.match(source, /Send refund email/);
  assert.match(source, /Send refund email again/);
  assert.match(source, /cancellation_email_sent_at/);
  assert.match(source, /Refund email last sent/);
  assert.match(source, /does not submit another refund or cancellation/);
  assert.match(source, /sendCancelledOrderRefundEmail\(orderId, requestId, token\)/);
  assert.match(api, /sendCancelledOrderRefundEmail/);
  assert.doesNotMatch(api, /cancelAndRefundOrder|cancelOrRefundSquarePayment|refundShippoTransaction/);
});

test("Admin operational tables expose details, paging, creation, and export controls", () => {
  const summary = read("admin-app/src/pages/SummaryPage.tsx");
  const orders = read("admin-app/src/pages/OrdersPage.tsx");
  const inventory = read("admin-app/src/pages/InventoryPage.tsx");
  const codes = read("admin-app/src/pages/DiscountCodesPage.tsx");
  const tax = read("admin-app/src/pages/SalesTaxPage.tsx");
  assert.match(summary, /Missing Shipping Cost/);
  assert.match(summary, /High Shipping Cost/);
  assert.match(summary, /Financial Review/);
  assert.doesNotMatch(summary, /lg:absolute lg:inset-0/);
  assert.match(summary, /Business snapshot/);
  assert.match(summary, /Operations overview/);
  assert.match(summary, /className="mt-auto pt-4"/);
  assert.doesNotMatch(summary, /Core results for the selected channel and time range\./);
  assert.doesNotMatch(summary, /Items needing attention, processing costs, shipping, and stock value\./);
  assert.match(orders, /Orders needing attention/);
  assert.match(orders, /Previous orders page/);
  assert.match(orders, /Next orders page/);
  assert.match(inventory, /visibleMovements/);
  assert.match(inventory, /Previous movement page/);
  assert.match(codes, /Add discount code/);
  assert.match(codes, /Random code/);
  assert.match(codes, /visibleCodes/);
  assert.match(tax, /Export CSV/);
  assert.match(tax, /text\/csv/);
});

test("Admin Inventory uses the deployed Vercel inventory function path", () => {
  const source = read("admin-app/src/lib/api.ts");
  assert.match(source, /fetchJson<InventoryDashboardResponse>\("\/api\/admin-inventory", token\)/);
  assert.match(source, /postJson<T>\("\/api\/admin-inventory", body, token\)/);
  assert.doesNotMatch(source, /"\/api\/admin\/inventory"/);
});

test("Admin staff authentication supports secure password recovery", () => {
  const authSource = read("admin-app/src/auth/AuthProvider.tsx");
  const appSource = read("admin-app/src/App.tsx");
  const vercelConfig = JSON.parse(read("vercel.json"));
  const rewrites = new Map(
    vercelConfig.rewrites.map(({ source, destination }) => [source, destination]),
  );

  assert.match(authSource, /event === "PASSWORD_RECOVERY"/);
  assert.match(authSource, /resetPasswordForEmail\(email, \{ redirectTo \}\)/);
  assert.match(authSource, /admin\/reset-password/);
  assert.match(authSource, /updateUser\(\{ password \}\)/);
  assert.match(authSource, /await client\.auth\.signOut\(\)/);
  assert.match(appSource, /Forgot password\?/);
  assert.match(appSource, /Choose a new password/);
  assert.match(appSource, /passwordConfirmation/);
  assert.match(appSource, /password\.length < 10/);
  assert.equal(
    rewrites.get("/admin/reset-password"),
    "/admin/index.html",
  );
});

test("Order Builder exposes audited admin free shipping after a carrier rate is selected", () => {
  const source = read("admin-app/src/pages/OrderBuilderPage.tsx");
  assert.match(source, /Offer free shipping to this customer/);
  assert.match(source, /Internal reason/);
  assert.match(source, /adminFreeShipping: \{ requested: true, reason:/);
  assert.match(source, /Customer shipping is \$0/);
  assert.match(source, /setAdminFreeShipping\(false\)/);
});

test("Orders drawer resolves persisted item totals without inventing zero-dollar lines", () => {
  const source = read("admin-app/src/pages/OrdersPage.tsx");

  assert.match(source, /\["lineTotalCents", "line_total_cents", "totalCents", "total_cents"\]/);
  assert.match(source, /\["unitPriceCents", "unit_price_cents", "priceCents", "price_cents"\]/);
  assert.match(source, /totalCents == null \? "Not recorded" : formatUsdCents\(totalCents\)/);
  assert.doesNotMatch(source, /Number\(record\.line_total_cents \|\| record\.total_cents \|\| 0\)/);
});
