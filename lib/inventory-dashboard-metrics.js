import { createClient } from "@supabase/supabase-js";

import { getBoxesPerCase } from "./bundles.js";
import { collectPhysicalStockDemands } from "./quote.js";
import { getProductMap, getSupportedSizesForProduct } from "./store.js";

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function isOrderCancelled(row) {
  return (
    String(row?.order_status || "").toLowerCase() === "cancelled" ||
    String(row?.status || "").toLowerCase() === "cancelled"
  );
}

function isOrderPaid(row) {
  return String(row?.status || "").toLowerCase() === "paid";
}

/** Matches admin fulfillment: shipped when order_status is shipped or staff handoff recorded. */
function isOrderShipped(row) {
  return String(row?.order_status || "") === "shipped" || Boolean(row?.admin_handoff_at);
}

function parseItemsField(items) {
  if (Array.isArray(items)) {
    return items;
  }
  if (typeof items === "string") {
    const t = items.trim();
    if (!t) {
      return [];
    }
    try {
      const p = JSON.parse(t);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * When `items` lacks per-size maps, fall back to lineCases / lineBoxCount on the first catalog size
 * so shipped totals stay non-zero for older rows.
 */
function mergeLegacyLineTotalsIntoDemand(items, productMap, demand) {
  const out = new Map(demand);
  const normalizedItems = Array.isArray(items) ? items : [];

  for (const item of normalizedItems) {
    const slug = String(item?.slug || "").trim();
    const product = productMap.get(slug);
    if (!product) {
      continue;
    }
    const hasPerSize = [...out.keys()].some((k) => k.startsWith(`${slug}\t`));
    if (hasPerSize) {
      continue;
    }
    const cases = Math.max(0, Math.floor(Number(item?.lineCases) || 0));
    const boxes = Math.max(0, Math.floor(Number(item?.lineBoxCount) || 0));
    if (!cases && !boxes) {
      continue;
    }
    const sizes = getSupportedSizesForProduct(product);
    const sizeStr = String(sizes[0] || "").trim();
    if (!sizeStr) {
      continue;
    }
    if (cases > 0) {
      const k = `${slug}\t${sizeStr}\tcase`;
      out.set(k, (out.get(k) || 0) + cases);
    }
    if (boxes > 0) {
      const k = `${slug}\t${sizeStr}\tbox`;
      out.set(k, (out.get(k) || 0) + boxes);
    }
  }
  return out;
}

function demandForOrderItems(items, productMap) {
  const base = collectPhysicalStockDemands(items);
  return mergeLegacyLineTotalsIntoDemand(items, productMap, base);
}

function mergeDemandInto(target, source) {
  for (const [k, v] of source.entries()) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    if (!n) {
      continue;
    }
    target.set(k, (target.get(k) || 0) + n);
  }
}

/**
 * Roll physical case/box units into display cases + loose boxes using each product's boxesPerCase.
 * When multiple pack sizes appear, cases/boxes are summed per product (no cross-product carry).
 */
function aggregateCasesBoxesFromDemand(demandMap, productMap) {
  const bySlug = new Map();
  for (const [key, n] of demandMap.entries()) {
    const parts = key.split("\t");
    if (parts.length !== 3) {
      continue;
    }
    const [slug, , channel] = parts;
    const qty = Math.max(0, Math.floor(Number(n) || 0));
    if (!qty) {
      continue;
    }
    const cur = bySlug.get(slug) || { caseUnits: 0, boxUnits: 0 };
    if (channel === "case") {
      cur.caseUnits += qty;
    } else if (channel === "box") {
      cur.boxUnits += qty;
    }
    bySlug.set(slug, cur);
  }

  const perSlug = [];
  const bpces = new Set();
  for (const [slug, { caseUnits, boxUnits }] of bySlug) {
    const product = productMap.get(slug);
    if (!product) {
      continue;
    }
    const bpc = getBoxesPerCase(product);
    bpces.add(bpc);
    const equiv = caseUnits * bpc + boxUnits;
    perSlug.push({ slug, bpc, equiv });
  }

  if (!perSlug.length) {
    return { totalCases: 0, totalBoxes: 0, mixedPackSizes: false };
  }

  if (bpces.size === 1) {
    const bpc = [...bpces][0];
    const totalEquiv = perSlug.reduce((s, x) => s + x.equiv, 0);
    return {
      totalCases: Math.floor(totalEquiv / bpc),
      totalBoxes: totalEquiv % bpc,
      mixedPackSizes: false,
    };
  }

  let totalCases = 0;
  let totalBoxes = 0;
  for (const x of perSlug) {
    totalCases += Math.floor(x.equiv / x.bpc);
    totalBoxes += x.equiv % x.bpc;
  }
  return { totalCases, totalBoxes, mixedPackSizes: true };
}

/**
 * Shipped/fulfilled demand (all paid or unpaid rows that are shipped, excluding cancelled).
 * To-be-shipped: paid, not shipped, not cancelled.
 */
export async function fetchInventoryDashboardOrderMetrics() {
  const client = getServiceClient();
  if (!client) {
    return {
      ok: false,
      reason: "no_supabase",
      soldCases: 0,
      soldBoxes: 0,
      soldMixedPackSizes: false,
      toShipCases: 0,
      toShipBoxes: 0,
      toShipMixedPackSizes: false,
    };
  }

  const { data, error } = await client
    .from("orders")
    .select("status,order_status,admin_handoff_at,items");

  if (error) {
    throw error;
  }

  const productMap = getProductMap();
  const soldDemand = new Map();
  const toShipDemand = new Map();

  for (const row of data || []) {
    if (isOrderCancelled(row)) {
      continue;
    }
    const items = parseItemsField(row.items);
    if (!items.length) {
      continue;
    }
    const demand = demandForOrderItems(items, productMap);
    if (demand.size === 0) {
      continue;
    }

    if (isOrderShipped(row)) {
      mergeDemandInto(soldDemand, demand);
    }
    if (isOrderPaid(row) && !isOrderShipped(row)) {
      mergeDemandInto(toShipDemand, demand);
    }
  }

  const sold = aggregateCasesBoxesFromDemand(soldDemand, productMap);
  const toShip = aggregateCasesBoxesFromDemand(toShipDemand, productMap);

  return {
    ok: true,
    soldCases: sold.totalCases,
    soldBoxes: sold.totalBoxes,
    soldMixedPackSizes: sold.mixedPackSizes,
    toShipCases: toShip.totalCases,
    toShipBoxes: toShip.totalBoxes,
    toShipMixedPackSizes: toShip.mixedPackSizes,
  };
}
