import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { allocateMarketplaceNetLineRevenue, buildSummaryDateRange } from "./admin-summary.js";

test("summary Today follows America/Chicago rather than UTC", () => {
  const range = buildSummaryDateRange({ preset: "today", now: new Date("2026-08-27T04:30:00.000Z") });
  assert.equal(range.startIsoDate, "2026-08-26");
  assert.equal(range.endIsoDate, "2026-08-26");
  assert.equal(range.start.toISOString(), "2026-08-26T05:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-08-27T05:00:00.000Z");
});

test("custom summary dates use Central business-day boundaries", () => {
  const summer = buildSummaryDateRange({ preset: "custom", start: "2026-08-01", end: "2026-08-02" });
  assert.equal(summer.start.toISOString(), "2026-08-01T05:00:00.000Z");
  assert.equal(summer.endExclusive.toISOString(), "2026-08-03T05:00:00.000Z");

  const winter = buildSummaryDateRange({ preset: "custom", start: "2026-12-01", end: "2026-12-01" });
  assert.equal(winter.start.toISOString(), "2026-12-01T06:00:00.000Z");
  assert.equal(winter.endExclusive.toISOString(), "2026-12-02T06:00:00.000Z");
});

test("marketplace adjustments are allocated proportionally and exactly", () => {
  const allocated = allocateMarketplaceNetLineRevenue(
    [{ line_revenue_cents: 8000 }, { line_revenue_cents: 2000 }],
    1000,
    500,
  );
  assert.deepEqual(allocated, [6800, 1700]);
  assert.equal(allocated.reduce((sum, cents) => sum + cents, 0), 8500);
});

test("marketplace adjustments cannot drive product revenue below zero", () => {
  assert.deepEqual(
    allocateMarketplaceNetLineRevenue([{ line_revenue_cents: 7999 }, { line_revenue_cents: 1 }], 9000, 500),
    [0, 0],
  );
});

test("Summary UI uses the filtered state dataset and explicit financial labels", () => {
  const source = fs.readFileSync(new URL("../admin-v2.5/src/pages/SummaryPage.tsx", import.meta.url), "utf8");
  assert.match(source, /State Revenue Ranking/);
  assert.match(source, /summary\.breakdown\?\.stateRevenue/);
  assert.match(source, /Merchandise revenue/);
  assert.match(source, /Stock List-Price Potential/);
  assert.doesNotMatch(source, /Shipping Zone Ranking/);
  assert.doesNotMatch(source, />Paid revenue</);
});

test("Summary keeps reconciliation data out of the dashboard layout", () => {
  const source = fs.readFileSync(new URL("../admin-v2.5/src/pages/SummaryPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Profit reconciliation/);
  assert.doesNotMatch(source, /FinancialReconciliationPanel/);
});
