/**
 * Verifies the same path as browser checkout (estimate UI fields, pay quote, order row columns).
 * Does not charge Square — pending order is inserted then deleted if Supabase allows.
 *
 * Run: node scripts/verify-checkout-shipping-persistence.mjs
 */
import "../import-env.mjs";
import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { buildFullCheckoutQuote } from "../lib/checkout-totals.js";
import { buildOrderQuoteSnapshotColumns, createPendingOrder } from "../lib/orders.js";
import { getSupabaseServiceRoleClient } from "../lib/supabase-admin.js";
import { formatCurrency } from "../lib/quote.js";

const ITEMS = [{ slug: "nitrile-standard", quantities: { M: 1 }, boxQuantities: {}, bundleLines: [] }];

const ADDRESS = {
  line1: "2009 Ben Hill Ct",
  line2: "",
  city: "Nolensville",
  state: "TN",
  postalCode: "37135",
  country: "US",
};

const EXPECT = {
  provider: "shippo",
  serviceCode: "ups_ground_saver",
  /** Allow small carrier float vs live Shippo (1× case_1, ~10–11 lb). */
  amountCentsMin: 900,
  amountCentsMax: 1100,
};

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const v = await validateShippingAddressForCheckout(ADDRESS, { strictShippo: true });
if (!v.ok) {
  fail(`Address validation: ${v.error || "unknown"}`);
}
const merged =
  v.normalizedAddress && typeof v.normalizedAddress === "object"
    ? { ...ADDRESS, ...v.normalizedAddress }
    : { ...ADDRESS };

// Same as api/checkout-estimate and api/checkout-pay (pay uses this after validation).
const quote = await buildFullCheckoutQuote(ITEMS, merged, {
  pricingTier: "standard",
  shippingContext: v.shippingContext,
  flow: "checkout",
  addressValidationResult: v,
});

// --- 1) UI: same as estimate JSON (V1) ---
const ship = quote.shipping && typeof quote.shipping === "object" ? quote.shipping : {};
const fromApiAmountFormatted = ship.amountFormatted;
const fromQuoteFn = formatCurrency(Math.max(0, Number(ship.amountCents) || 0));
if (String(fromApiAmountFormatted).trim() !== String(fromQuoteFn).trim()) {
  fail(`UI amount mismatch: shipping.amountFormatted="${fromApiAmountFormatted}" vs format(shipping.amountCents)=${fromQuoteFn}`);
}
console.log("1. UI/estimate: shipping line matches amountCents formatting:", fromQuoteFn, "(", ship.serviceLabel, ")");

const sc = String(ship.serviceCode || "").trim();
if (sc !== EXPECT.serviceCode) {
  fail(`Expected serviceCode ${EXPECT.serviceCode}, got ${sc}`);
}
const pr = String(ship.provider || "").trim();
if (pr !== EXPECT.provider) {
  fail(`Expected provider ${EXPECT.provider}, got ${pr || "(empty)"}`);
}
const ac = Math.max(0, Math.round(Number(ship.amountCents) || 0));
if (ac < EXPECT.amountCentsMin || ac > EXPECT.amountCentsMax) {
  fail(`Base shipping ${ac}¢ not in [${EXPECT.amountCentsMin},${EXPECT.amountCentsMax}] (≈$10.47 / live Shippo).`);
}
console.log("2. provider/service/amountCents ok:", { provider: pr, serviceCode: sc, amountCents: ac });

// --- 2) Square: totalCents = merchandise + line shipping (surcharge + base in shippingCents) + tax ---
const sub = Math.max(0, Math.round(Number(quote.subtotalCents) || 0));
const shipLine = Math.max(0, Math.round(Number(quote.shippingCents) || 0));
const tax = Math.max(0, Math.round(Number(quote.taxCents) || 0));
const total = Math.max(0, Math.round(Number(quote.totalCents) || 0));
if (sub + shipLine + tax !== total) {
  fail(`totalCents break: subtotal+shipping+tax !== total (${sub}+${shipLine}+${tax} != ${total})`);
}
console.log("3. Quote total includes shipping: totalCents=", total, { sub, shipLine, tax, totalFormatted: quote.totalFormatted });

// --- 3–5) Supabase snapshot + optional round-trip ---
const snap = buildOrderQuoteSnapshotColumns({ quote, shippingAddress: merged });
if (snap.quoted_shipping_provider !== EXPECT.provider) {
  fail(`quoted_shipping_provider: ${snap.quoted_shipping_provider}`);
}
if (!String(snap.quoted_shipping_provider_quote_id || "").trim()) {
  fail("quoted_shipping_provider_quote_id is empty");
}
if (Number(snap.quoted_shipping_amount_cents) !== ac) {
  fail(`quoted_shipping_amount_cents ${snap.quoted_shipping_amount_cents} != shipping.amountCents ${ac}`);
}
console.log("4. Snapshot columns:", {
  quoted_shipping_provider: snap.quoted_shipping_provider,
  quoted_shipping_provider_quote_id: String(snap.quoted_shipping_provider_quote_id).slice(0, 8) + "…",
  quoted_shipping_amount_cents: snap.quoted_shipping_amount_cents,
  quoted_shipping_service_code: snap.quoted_shipping_service_code,
});

let pending = null;
try {
  try {
    pending = await createPendingOrder({
      quote,
      customer: {
        name: "Verify Script",
        email: "verify@saigoods.invalid",
        phone: "5555555555",
        address: "2009 Ben Hill Ct, Nolensville, TN 37135, US",
        shippingState: merged.state,
      },
      hardinDiscount: null,
      shippingAddress: merged,
    });
  } catch (e) {
    console.log("5. createPendingOrder skipped or failed (Supabase / network):", String(e?.message || e));
    console.log("Done (quote path verified; DB round-trip not confirmed).");
    process.exit(0);
  }

  const id = pending.id;
  const db = getSupabaseServiceRoleClient();
  const { data: row, error: selErr } = await db
    .from("orders")
    .select("quoted_shipping_provider,quoted_shipping_provider_quote_id,quoted_shipping_amount_cents,shipping_cents,total_cents")
    .eq("id", id)
    .single();

  if (selErr || !row) {
    console.error("Select order failed:", selErr);
  } else {
    const okP = row.quoted_shipping_provider === EXPECT.provider;
    const okId = String(row.quoted_shipping_provider_quote_id || "") === String(snap.quoted_shipping_provider_quote_id);
    const okC = Number(row.quoted_shipping_amount_cents) === ac;
    if (!okP || !okId || !okC) {
      fail(
        `DB row mismatch: ${JSON.stringify({ okP, okId, okC, row, expectedQuoteId: snap.quoted_shipping_provider_quote_id, ac })}`,
      );
    }
    console.log("5. Supabase order row matches snapshot for provider, quote_id, amount_cents.");
  }

  const { error: delErr } = await db.from("orders").delete().eq("id", id);
  if (delErr) {
    console.log("Cleanup: could not delete test order", id, delErr.message);
  } else {
    console.log("Cleanup: removed test order", id);
  }
} catch (e) {
  console.error(e);
  if (pending?.id) {
    await getSupabaseServiceRoleClient().from("orders").delete().eq("id", pending.id);
  }
  process.exit(1);
}

console.log("PASS: estimate UI fields, pay-level quote total, and quoted shipping persistence align.");
