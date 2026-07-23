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
  assert.match(source, /summaryLoadGen/);
  assert.match(source, /alreadyLoaded/);
  assert.match(source, /Showing previously loaded summary/);
  assert.match(source, /if \(gen !== summaryLoadGen\) return/);
});

test("Orders read-only wording, noreferrer, and load generation", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /Suggested next \(Legacy\)/);
  assert.doesNotMatch(source, /<th>Next Action<\/th>/);
  assert.match(source, /Paid · not shipped \(label complete\)/);
  assert.doesNotMatch(source, /Ready to mark shipped/);
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
