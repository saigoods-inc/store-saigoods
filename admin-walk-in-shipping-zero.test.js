import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeCheckoutEstimate } from "./lib/checkout-estimate-logic.js";
import { computeWalkInZeroShippingQuote } from "./lib/walk-in-quote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.INVENTORY_BACKEND = "file";
process.env.SHIPPING_QUOTE_MODE = "live_ups";

const SAMPLE_ITEM = {
  slug: "black-nitrile-general",
  bundleLines: [{ id: "box_1", qty: 1 }],
  quantities: {},
  boxQuantities: { M: 1 },
};

test("Walk-in zero-shipping quote never uses live carrier amounts", async () => {
  const quote = await computeWalkInZeroShippingQuote({
    items: [SAMPLE_ITEM],
    applyEligibleLocalDiscount: false,
    selectedShippingAmountCents: 99999,
    selectedShippingProvider: "ups",
    selectedShippingServiceCode: "ups_ground",
    fulfillmentMethod: "carrier",
  });

  assert.equal(quote.shippingCents, 0);
  assert.equal(quote.residentialSurchargeCents, 0);
  assert.equal(quote.walkInZeroShipping, true);
  assert.equal(quote.flow, "admin_walk_in");
  assert.equal(quote.shipping?.quoteStatus || quote.shippingQuoteStatus, "included_in_merchandise");
  assert.equal(Number(quote.shipping?.taxableShippingCents || 0), 0);
  assert.equal(quote.canCheckout, true);
  assert.equal(
    quote.totalCents,
    Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.taxCents) || 0),
  );
});

test("computeCheckoutEstimate with walkInPickup ignores browser shipping fields", async () => {
  const quote = await computeCheckoutEstimate(
    {
      items: [SAMPLE_ITEM],
      address: {
        line1: "123 Fake Carrier St",
        city: "Memphis",
        state: "TN",
        postalCode: "38103",
        country: "US",
      },
      applyEligibleLocalDiscount: true,
      fulfillmentMethod: "carrier",
      selectedShippingAmountCents: 4500,
      selectedShippingResidentialSurchargeCents: 650,
    },
    {
      walkInPickup: true,
      adminLocalDiscount: true,
      requireCompleteAddress: true,
    },
  );

  assert.equal(quote.shippingCents, 0);
  assert.equal(quote.residentialSurchargeCents, 0);
  assert.equal(quote.hardinDiscountApplied, true);
  assert.equal(quote.walkInZeroShipping, true);
  assert.match(String(quote.warnings || []), /shipping is \$0/i);
});

test("migration patch-walk-in-order-complete.sql defines durable claim + RPC", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "sql", "patch-walk-in-order-complete.sql"),
    "utf8",
  );
  assert.match(sql, /inventory_committed_at/);
  assert.match(sql, /inventory_movements_walk_in_sale_order_variant_uidx/);
  assert.match(sql, /walk_in_order_complete/);
  assert.match(sql, /admin_handoff_at/);
  assert.match(sql, /order_status = 'shipped'/);
  assert.match(sql, /v_completed_at/);
  assert.match(sql, /v_payment_id/);
  assert.match(sql, /v_payment_method/);
  assert.match(sql, /update public\.orders as ord/);
  assert.match(sql, /payment_id = v_payment_id/);
  assert.match(sql, /paid_at = v_completed_at/);
  assert.match(sql, /admin_handoff_at = v_completed_at/);
  assert.match(sql, /inventory_committed_at = v_completed_at/);
  assert.match(sql, /updated_at = v_completed_at/);
  assert.match(sql, /fulfillment_method = 'pickup'/);
  assert.doesNotMatch(sql, /fulfillment_method = coalesce\(/);
  assert.match(sql, /shipping_required = false/);
  assert.match(sql, /shippo_label_required = false/);
  assert.match(sql, /p_order_id bigint/);
  assert.match(sql, /v_order_id_text := p_order_id::text/);
  assert.match(
    sql,
    /comment on function public\.walk_in_order_complete\(bigint, text, jsonb, text\)/,
  );
  assert.match(
    sql,
    /revoke execute on function public\.walk_in_order_complete\(bigint, text, jsonb, text\)/,
  );
  assert.match(sql, /from public, anon, authenticated/);
  assert.match(
    sql,
    /grant execute on function public\.walk_in_order_complete\(bigint, text, jsonb, text\)/,
  );
  assert.match(sql, /to service_role/);
  assert.doesNotMatch(
    sql,
    /walk_in_order_complete\s*\(\s*uuid\b/i,
    "no active walk_in_order_complete(uuid, ...) signature",
  );
  assert.doesNotMatch(sql, /p_order_id\s+uuid\b/);
  assert.doesNotMatch(
    sql,
    /walk_in_order_complete\(uuid,\s*text,\s*jsonb,\s*text\)/,
  );
  assert.match(sql, /trim\(coalesce\(o\.order_status, ''\)\) = 'shipped'/);
  assert.match(sql, /lower\(coalesce\(o\.status, ''\)\) = 'paid'/);
  assert.match(sql, /o\.inventory_committed_at is not null/);
  assert.match(sql, /o\.admin_handoff_at is not null/);
  assert.match(sql, /movement_type/);
  assert.match(sql, /walk_in_sale/);
  assert.match(sql, /reference_type/);
  assert.match(sql, /reference_id/);
  assert.match(sql, /Invalid walk-in inventory operation\./);
  assert.match(sql, /Walk-in inventory operation does not belong to this order\./);
  assert.match(sql, /Duplicate variant in walk-in inventory operations\./);
  assert.match(sql, /v_vid::uuid/);
  assert.match(sql, /v_seen \? v_vid/);
  assert.match(sql, /group by reference_id, variant_id/);
  assert.match(sql, /having count\(\*\) > 1/);
  assert.match(sql, /Do not delete or rewrite duplicates automatically/);
  assert.match(sql, /order_source = 'walk_in'/);
  assert.match(sql, /Applying the migration does not backfill the marker/);
  assert.match(sql, /Do not mark a historical order committed/);
  assert.match(sql, /Do not decrement inventory automatically/);

  // Split historical inspection: A = pre-migration (no marker column), B = post-migration.
  const preflightStart = sql.indexOf("-- A. Before applying the migration");
  const postflightStart = sql.indexOf("-- B. After applying the migration");
  const schemaStart = sql.indexOf("-- 1) Order-level inventory commit claim");
  assert.ok(preflightStart >= 0, "pre-migration historical query section A missing");
  assert.ok(postflightStart > preflightStart, "post-migration section B missing or out of order");
  assert.ok(schemaStart > postflightStart, "schema section must follow preflight comments");

  const sectionA = sql.slice(preflightStart, postflightStart);
  const sectionB = sql.slice(postflightStart, schemaStart);

  const preMigrationQuery = sectionA.match(/--\s+select[\s\S]*?;/);
  assert.ok(preMigrationQuery, "pre-migration SELECT missing from section A");
  assert.match(preMigrationQuery[0], /select id, order_ref, payment_method, paid_at, order_status, admin_handoff_at/);
  assert.match(preMigrationQuery[0], /status, created_at, updated_at/);
  assert.match(preMigrationQuery[0], /order_source = 'walk_in'/);
  assert.match(preMigrationQuery[0], /lower\(coalesce\(status, ''\)\) = 'paid'/);
  assert.doesNotMatch(
    preMigrationQuery[0],
    /inventory_committed_at/,
    "pre-migration query must not depend on inventory_committed_at",
  );
  assert.doesNotMatch(preMigrationQuery[0], /\b(update|delete|insert)\b/i);

  const postMigrationQuery = sectionB.match(/--\s+select[\s\S]*?;/);
  assert.ok(postMigrationQuery, "post-migration SELECT missing from section B");
  assert.match(postMigrationQuery[0], /inventory_committed_at is null/);
  assert.match(postMigrationQuery[0], /order_source = 'walk_in'/);
  assert.match(postMigrationQuery[0], /lower\(coalesce\(status, ''\)\) = 'paid'/);
  assert.doesNotMatch(postMigrationQuery[0], /\b(update|delete|insert)\b/i);
  assert.doesNotMatch(sectionA + sectionB, /\bupdate\s+public\.orders\b/i);
  assert.doesNotMatch(sectionA + sectionB, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sectionA + sectionB, /\binsert\s+into\b/i);
  assert.match(sectionB, /Applying the migration does not backfill the marker/);

  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /paid_at\s*=\s*paid_at/);
  assert.doesNotMatch(sql, /payment_id\s*=\s*payment_id/);
  assert.doesNotMatch(sql, /admin_handoff_at\s*=\s*paid_at/);
  assert.doesNotMatch(sql, /inventory_committed_at\s*=\s*paid_at/);
});
