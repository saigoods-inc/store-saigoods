import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

test("Summary shipping KPI wording and refresh preserve/stale-load guards", () => {
  const source = read("public/js/v2/admin-summary.js");
  assert.match(source, /Per order with known label cost/);
  assert.doesNotMatch(source, /Per shipped order/);
  assert.match(source, /In selected range/);
  assert.match(source, /let currentPreset = "all"/);
  assert.match(source, /let currentProductPreset = "all"/);
  assert.match(source, /let currentSalesOverviewPreset = "all"/);
  assert.match(source, /currentPreset = presetSel\.value \|\| "all"/);
  assert.match(source, /PRODUCT_PRESET_OPTIONS/);
  assert.match(source, /id:\s*"sg-product-preset"/);
  assert.match(source, /SALES_OVERVIEW_PRESET_OPTIONS/);
  assert.match(source, /id:\s*"sg-sales-preset"/);
  assert.match(source, /value:\s*"all",\s*label:\s*"All Product"/);
  assert.match(source, /Loading sales overview/);
  assert.match(source, /Loading product performance/);
  assert.match(source, /Paid revenue by/);
  assert.match(source, /buildSalesOverviewRows/);
  assert.match(source, /Avg\. order/);
  assert.match(source, /net after variable costs/i);
  assert.match(source, /sg-chart__tooltip/);
  assert.doesNotMatch(source, /id:\s*"sg-sales-cadence"/);
  assert.doesNotMatch(source, /Best revenue week/);
  assert.doesNotMatch(source, /Busiest week/);
  assert.doesNotMatch(source, /Highest shipping week/);
  assert.doesNotMatch(source, /1970-01-01 →/);
  assert.doesNotMatch(source, /Weekly operations pulse/);
  assert.doesNotMatch(source, /Compare paid revenue, order volume, shipping spend/);
  assert.match(source, /summaryLoadGen/);
  assert.match(source, /salesOverviewLoadGen/);
  assert.match(source, /alreadyLoaded/);
  assert.match(source, /Showing previously loaded summary/);
  assert.match(source, /if \(gen !== summaryLoadGen\) return/);
  assert.match(source, /fetchSummaryForPreset/);
});

test("Summary dashboard remains bound to live admin summary KPI and breakdown fields", () => {
  const source = read("public/js/v2/admin-summary.js");
  const reportSource = read("lib/admin-summary.js");

  assert.match(source, /fetchSummaryForPreset\(currentPreset, token, \{ force \}\)/);
  assert.match(source, /fetchReportJson\(`\/api\/admin-summary\?preset=\$\{encodeURIComponent\(key\)\}`/);
  assert.match(source, /label:\s*"Current Profit"/);
  assert.match(source, /currentProfitCents/);
  assert.match(source, /label:\s*"Total Orders"/);
  assert.match(source, /totalOrders/);
  assert.match(source, /label:\s*"Total Revenue"/);
  assert.match(source, /totalRevenueCents/);
  assert.match(source, /label:\s*"Average Order Value"/);
  assert.match(source, /averageOrderValueCents/);
  assert.match(source, /label:\s*"Shipping Expense"/);
  assert.match(source, /totalShippingExpenseCents/);
  assert.match(source, /label:\s*"Profit from Shipping"/);
  assert.match(source, /totalShippingVarianceCents/);
  assert.match(source, /label:\s*"Avg\. Shipping Cost"/);
  assert.match(source, /averageShippingPerOrderCents/);
  assert.match(source, /title:\s*"Sales Overview"/);
  assert.match(source, /revenueTrend/);
  assert.match(source, /title:\s*"Product Performance"/);
  assert.match(source, /productRanking/);
  assert.match(source, /title:\s*"Recent Orders"/);
  assert.match(source, /recentFinancialActivity/);
  assert.match(source, /title:\s*"Inventory Health"/);
  assert.match(source, /inventoryOutOfStock/);
  assert.match(source, /lowInventory/);
  assert.match(source, /title:\s*"Shipping Zone Ranking"/);
  assert.match(source, /summary\?\.breakdown\?\.shipping\?\.zones/);

  assert.match(reportSource, /currentProfitCents,/);
  assert.match(reportSource, /totalOrders,/);
  assert.match(reportSource, /totalRevenueCents,/);
  assert.match(reportSource, /averageOrderValueCents,/);
  assert.match(reportSource, /totalShippingExpenseCents,/);
  assert.match(reportSource, /totalShippingVarianceCents,/);
  assert.match(reportSource, /averageShippingPerOrderCents,/);
  assert.match(reportSource, /productRanking,/);
  assert.match(reportSource, /recentFinancialActivity: recentOrders\.slice\(0, 20\)/);
  assert.match(reportSource, /inventoryOutOfStock: inventoryAlerts\.inventoryOutOfStock/);
  assert.match(reportSource, /lowInventory: inventoryAlerts\.lowInventory/);
  assert.match(reportSource, /zones,/);
  assert.match(reportSource, /grossChargeCents - collectedTaxCents/);
  assert.match(reportSource, /const grossCharge = orderGrossChargeCents\(row\)/);
});

test("Advanced bundle pricing follows box-to-carton hierarchy", () => {
  const source = read("admin-v2.5/src/pages/AdvancedPage.tsx");

  assert.match(source, /function compareBundleHierarchy/);
  assert.match(source, /a\.kind === "case" \? 1 : 0/);
  assert.match(source, /a\.units - b\.units/);
  assert.match(source, /\.sort\(compareBundleHierarchy\)/);
});

test("admin-v2.5 Advanced page uses a browser-session access gate", () => {
  const app = read("admin-v2.5/src/App.tsx");
  const shell = read("admin-v2.5/src/components/layout/AdminShell.tsx");

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

test("Orders writable wording, noreferrer, and load generation", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /<th>Suggested next<\/th>/);
  assert.doesNotMatch(source, /Suggested next \(Legacy\)/);
  assert.match(source, /Paid · not shipped \(label complete\)/);
  assert.doesNotMatch(source, /Ready to mark shipped/);
  assert.doesNotMatch(source, /read-only/i);
  assert.match(source, /ordersLoadGen/);
  assert.match(source, /if \(gen !== ordersLoadGen\) return/);

  const blanks = [...source.matchAll(/target="_blank"[^>]*>/g)].map((m) => m[0]);
  assert.ok(blanks.length > 0);
  for (const tag of blanks) {
    assert.match(tag, /rel="noopener noreferrer"/);
  }
});

test("Manual Order uses drawer close guard during paymentLinkInFlight", () => {
  const source = read("public/js/v2/admin-manual-order.js");
  assert.match(source, /setDrawerCloseGuard/);
  assert.match(source, /setDrawerCloseGuard\(\(\) => !paymentLinkInFlight\)/);
  assert.match(source, /closeDrawer\(\{ force: true \}\)/);
  assert.match(source, /setDrawerCloseGuard\(null\)/);
  assert.match(source, /drawerCloseBtn\.disabled = true/);
});

test("Order Builder treats the selected carrier rate as an editable draft until creation", () => {
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");

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
  const orders = read("admin-v2.5/src/pages/OrdersPage.tsx");
  const builder = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");
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
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");
  const select = read("admin-v2.5/src/components/ui/CustomSelect.tsx");

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
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");
  const api = read("admin-v2.5/src/lib/api.ts");

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
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");

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
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");

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
  const source = read("admin-v2.5/src/pages/OrdersPage.tsx");
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

test("admin-v2.5 operational tables expose details, paging, creation, and export controls", () => {
  const summary = read("admin-v2.5/src/pages/SummaryPage.tsx");
  const orders = read("admin-v2.5/src/pages/OrdersPage.tsx");
  const inventory = read("admin-v2.5/src/pages/InventoryPage.tsx");
  const codes = read("admin-v2.5/src/pages/DiscountCodesPage.tsx");
  const tax = read("admin-v2.5/src/pages/SalesTaxPage.tsx");
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

test("admin-v2.5 Inventory uses the deployed Vercel inventory function path", () => {
  const source = read("admin-v2.5/src/lib/api.ts");
  assert.match(source, /fetchJson<InventoryDashboardResponse>\("\/api\/admin-inventory", token\)/);
  assert.match(source, /postJson<T>\("\/api\/admin-inventory", body, token\)/);
  assert.doesNotMatch(source, /"\/api\/admin\/inventory"/);
});

test("admin-v2.5 staff authentication supports secure password recovery", () => {
  const authSource = read("admin-v2.5/src/auth/AuthProvider.tsx");
  const appSource = read("admin-v2.5/src/App.tsx");
  const vercelConfig = JSON.parse(read("vercel.json"));
  const rewrites = new Map(
    vercelConfig.rewrites.map(({ source, destination }) => [source, destination]),
  );

  assert.match(authSource, /event === "PASSWORD_RECOVERY"/);
  assert.match(authSource, /resetPasswordForEmail\(email, \{ redirectTo \}\)/);
  assert.match(authSource, /admin-v2\.5\/reset-password/);
  assert.match(authSource, /updateUser\(\{ password \}\)/);
  assert.match(authSource, /await client\.auth\.signOut\(\)/);
  assert.match(appSource, /Forgot password\?/);
  assert.match(appSource, /Choose a new password/);
  assert.match(appSource, /passwordConfirmation/);
  assert.match(appSource, /password\.length < 10/);
  assert.equal(
    rewrites.get("/admin-v2.5/reset-password"),
    "/admin-v2.5/index.html",
  );
  assert.equal(
    rewrites.get("/admin-v2.5/reset-password/"),
    "/admin-v2.5/index.html",
  );
});

test("drawer focus trap excludes controls hidden by an ancestor", () => {
  const source = read("public/js/v2/ui.js");
  assert.match(source, /function isHiddenWithinDrawer\(/);
  assert.match(source, /isHiddenWithinDrawer\(el, root\)/);
  assert.match(source, /hasAttribute\("hidden"\)/);
  assert.match(source, /aria-hidden"\) === "true"/);
  assert.match(source, /inert === true/);
  assert.match(source, /hasAttribute\("inert"\)/);
  assert.match(source, /getComputedStyle/);
  assert.match(source, /visibility === "collapse"/);
});

test("custom summary filters use in-app selectbox UI instead of native browser select", () => {
  const source = read("public/js/v2/ui.js");
  assert.match(source, /data-selectbox/);
  assert.match(source, /sg-selectbox__trigger/);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "Escape"/);
});

test("Inventory Estimated Available copy, mutation guards, refresh block, load gen, field errors", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /Only Amazon FBM unshipped quantities reduce the Estimated available KPI/);
  assert.match(source, /not wholesale or manual/i);
  assert.match(source, /export function hasInventoryMutationInFlight/);
  assert.match(source, /let incomingSaveInFlight = false/);
  assert.match(source, /let incomingStatusInFlight = false/);
  assert.match(source, /incomingSaveInFlight = true/);
  assert.match(source, /incomingStatusInFlight = true/);
  assert.match(source, /Finish the current inventory action before refreshing/);
  assert.match(source, /stockLoadGen/);
  assert.match(source, /function setAssociatedFieldError/);
  assert.match(source, /aria-invalid/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /function refreshInventory/);
});

test("Tax KPIs use filtered rows; keyboard row openers exist", () => {
  const source = read("public/js/v2/admin-tax.js");
  assert.match(source, /function renderKpis\(\) \{\s*const rows = filteredRows\(\)/);
  assert.match(source, /kpiScopeLabel/);
  assert.match(source, /sg-tax-kpi-host/);
  assert.match(source, /tabindex="0"/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /Open details dialog for/);
  assert.doesNotMatch(source, /role="button"/);
  assert.match(source, /keydown/);
  assert.match(source, /e\.key === "Enter"/);
  assert.match(source, /e\.key === " " \|\| e\.key === "Spacebar"/);
  assert.match(source, /e\.preventDefault\(\)/);
});

test("Nexus keyboard openers and volume-relative activity wording", () => {
  const source = read("public/js/v2/admin-nexus.js");
  assert.match(source, /Higher volume/);
  assert.match(source, /Lower volume/);
  assert.match(source, /No recent activity/);
  assert.doesNotMatch(source, /statusChip\("Active"/);
  assert.match(source, /not a legal nexus determination/i);
  assert.match(source, /tabindex="0"/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /Open details dialog for/);
  assert.doesNotMatch(source, /role="button"/);
  assert.match(source, /e\.key === "Enter"/);
  assert.match(source, /e\.key === " " \|\| e\.key === "Spacebar"/);
  assert.match(source, /e\.preventDefault\(\)/);
});

test("Order Builder exposes audited admin free shipping after a carrier rate is selected", () => {
  const source = read("admin-v2.5/src/pages/OrderBuilderPage.tsx");
  assert.match(source, /Offer free shipping to this customer/);
  assert.match(source, /Internal reason/);
  assert.match(source, /adminFreeShipping: \{ requested: true, reason:/);
  assert.match(source, /Customer shipping is \$0/);
  assert.match(source, /setAdminFreeShipping\(false\)/);
});
