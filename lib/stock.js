import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectPhysicalStockDemands } from "./quote.js";
import { appendInventoryMovement, tailInventoryMovements } from "./inventory-movements.js";
import {
  newShipmentId,
  newShipmentLineId,
  readIncomingShipments,
  writeIncomingShipments,
} from "./inventory-shipments.js";
import { getProductMap, getKnownSizes, loadStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Variant-level inventory (`data/stock.json`) + movement log (`data/inventory-movements.json`)
 * + incoming shipments (`data/incoming-shipments.json`).
 *
 * Website paid orders: reserve demand on `markOrderPaid` (reserved↑, on_hand unchanged).
 * Shipped (handoff): on_hand↓ and reserved↓ by fulfilled demand.
 * Walk-in paid: on_hand↓ only (no reservation), logged as walk_in_sale.
 */

export function getStockPath() {
  return path.join(__dirname, "..", "data", "stock.json");
}

export function readStockData() {
  const filePath = getStockPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { schemaVersion: 2, lines: [] };
    }
    if (!Array.isArray(parsed.lines)) {
      return { ...parsed, lines: [] };
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { schemaVersion: 2, lines: [] };
    }
    throw err;
  }
}

/** Serialize mutations so concurrent checkouts do not corrupt inventory files. */
let stockWriteChain = Promise.resolve();

export function runStockMutation(fn) {
  const next = stockWriteChain.then(() => fn());
  stockWriteChain = next.catch((err) => {
    console.error("[stock] serialized mutation failed:", err);
  });
  return next;
}

function writeStockPayload(payload) {
  const target = getStockPath();
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.stock-write-${process.pid}-${Date.now()}.tmp`);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
}

function normaliseChannel(raw) {
  const c = String(raw || "").toLowerCase();
  if (c === "case" || c === "cases") return "case";
  if (c === "box" || c === "boxes") return "box";
  return null;
}

export function stockLineKey(slug, size, channel) {
  return `${String(slug)}\t${String(size)}\t${String(channel)}`;
}

function reorderThresholdFromLine(raw) {
  if (raw.reorderThreshold != null && raw.reorderThreshold !== "") {
    return Math.max(0, Math.floor(Number(raw.reorderThreshold)));
  }
  if (raw.lowStockThreshold != null && raw.lowStockThreshold !== "") {
    return Math.max(0, Math.floor(Number(raw.lowStockThreshold)));
  }
  return null;
}

function buildStockLineIndex(stockPayload) {
  const map = new Map();
  const lines = Array.isArray(stockPayload?.lines) ? stockPayload.lines : [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const slug = String(line.productSlug || "").trim();
    const size = String(line.size || "").trim();
    const channel = normaliseChannel(line.channel);
    if (!slug || !size || !channel) continue;
    const key = stockLineKey(slug, size, channel);
    const origC =
      channel === "case" && line.originalCartons != null && line.originalCartons !== ""
        ? Math.max(0, Math.floor(Number(line.originalCartons)))
        : null;
    const origB =
      channel === "box" && line.originalBoxes != null && line.originalBoxes !== ""
        ? Math.max(0, Math.floor(Number(line.originalBoxes)))
        : null;
    map.set(key, {
      productSlug: slug,
      size,
      channel,
      productName: line.productName != null ? String(line.productName).trim() || null : null,
      sku: line.sku != null ? String(line.sku) : null,
      active: line.active !== false,
      track: line.track === true,
      onHand: Math.max(0, Math.floor(Number(line.onHand) || 0)),
      reserved: Math.max(0, Math.floor(Number(line.reserved) || 0)),
      incoming: Math.max(0, Math.floor(Number(line.incoming) || 0)),
      damaged: Math.max(0, Math.floor(Number(line.damaged) || 0)),
      reorderThreshold: reorderThresholdFromLine(line),
      updatedAt: line.updatedAt ? String(line.updatedAt) : null,
      originalCartons: origC,
      originalBoxes: origB,
    });
  }
  return map;
}

function touchLine(line) {
  line.updatedAt = new Date().toISOString();
}

function inventorySnapshot(line) {
  return {
    onHand: line.onHand,
    reserved: line.reserved,
    incoming: line.incoming,
    damaged: line.damaged,
    track: !!line.track,
    active: line.active !== false,
    originalCartons: line.originalCartons != null ? line.originalCartons : null,
    originalBoxes: line.originalBoxes != null ? line.originalBoxes : null,
  };
}

function logVariantMovement({
  line,
  actionType,
  quantityDelta,
  before,
  after,
  reason,
  referenceType,
  referenceId,
  adminUser,
}) {
  appendInventoryMovement({
    variantKey: stockLineKey(line.productSlug, line.size, line.channel),
    productSlug: line.productSlug,
    size: line.size,
    channel: line.channel,
    actionType,
    quantityDelta,
    before,
    after,
    reason: reason || "",
    referenceType: referenceType || null,
    referenceId: referenceId != null ? String(referenceId) : null,
    adminUser: adminUser || null,
  });
}

function indexToSortedLines(index) {
  return [...index.keys()]
    .sort()
    .map((k) => index.get(k))
    .map((line) => {
      const o = {
        productSlug: line.productSlug,
        size: line.size,
        channel: line.channel,
        onHand: Math.max(0, Math.floor(Number(line.onHand) || 0)),
        reserved: Math.max(0, Math.floor(Number(line.reserved) || 0)),
        incoming: Math.max(0, Math.floor(Number(line.incoming) || 0)),
        damaged: Math.max(0, Math.floor(Number(line.damaged) || 0)),
      };
      if (line.productName) o.productName = line.productName;
      if (line.track === true) o.track = true;
      if (line.active === false) o.active = false;
      if (line.sku) o.sku = line.sku;
      if (line.reorderThreshold != null && line.reorderThreshold !== "") {
        o.reorderThreshold = line.reorderThreshold;
      }
      if (line.channel === "case" && line.originalCartons != null && line.originalCartons !== "") {
        o.originalCartons = Math.max(0, Math.floor(Number(line.originalCartons)));
      }
      if (line.channel === "box" && line.originalBoxes != null && line.originalBoxes !== "") {
        o.originalBoxes = Math.max(0, Math.floor(Number(line.originalBoxes)));
      }
      if (line.updatedAt) o.updatedAt = line.updatedAt;
      return o;
    });
}

export function availableUnits(line) {
  if (!line || !line.track || line.active === false) return Number.POSITIVE_INFINITY;
  return Math.max(0, line.onHand - line.reserved);
}

/**
 * @param {ReturnType<typeof buildStockLineIndex> extends Map<any, infer V> ? V : never} line
 */
export function computeInventoryStatus(line) {
  if (!line || line.active === false) return "Not tracked";
  if (!line.track) return "Not tracked";
  const avail = Math.max(0, line.onHand - line.reserved);
  const incoming = Math.max(0, line.incoming || 0);
  const th = line.reorderThreshold;
  if (avail <= 0 && incoming > 0) return "Incoming";
  if (avail <= 0) return "Out of stock";
  if (th != null && avail <= th) return "Low stock";
  return "In stock";
}

function publicInventoryLine(line) {
  const avail = availableUnits(line);
  const status = computeInventoryStatus(line);
  return {
    productSlug: line.productSlug,
    productName: line.productName || null,
    size: line.size,
    channel: line.channel,
    sku: line.sku,
    active: line.active !== false,
    track: line.track,
    onHand: line.onHand,
    reserved: line.reserved,
    incoming: line.incoming,
    damaged: line.damaged,
    available: Number.isFinite(avail) ? avail : null,
    reorderThreshold: line.reorderThreshold,
    updatedAt: line.updatedAt || null,
    status,
  };
}

export function mergeInventoryIntoStore(storePayload) {
  const stockPayload = readStockData();
  const index = buildStockLineIndex(stockPayload);
  const bySlug = new Map();
  for (const line of index.values()) {
    if (!bySlug.has(line.productSlug)) bySlug.set(line.productSlug, []);
    bySlug.get(line.productSlug).push(publicInventoryLine(line));
  }

  const products = Array.isArray(storePayload?.products) ? storePayload.products : [];
  return {
    ...storePayload,
    inventorySchemaVersion: 2,
    products: products.map((p) => ({
      ...p,
      inventory: {
        schemaVersion: 2,
        lines: bySlug.get(p.slug) || [],
      },
    })),
  };
}

export function mergeInventoryIntoProduct(product) {
  if (!product || typeof product !== "object") return product;
  const merged = mergeInventoryIntoStore({ products: [product] });
  const next = merged.products[0];
  return next || product;
}

/**
 * @throws {Error & { statusCode?: number, stockShortfalls?: object[] }}
 */
export function assertStockAvailableForItems(items) {
  const demand = collectPhysicalStockDemands(items);
  const index = buildStockLineIndex(readStockData());
  const shortfalls = [];

  for (const [key, need] of demand) {
    const parts = key.split("\t");
    const slug = parts[0];
    const size = parts[1];
    const channel = parts[2];
    const line = index.get(key);
    if (!line || !line.track || line.active === false) continue;
    const available = availableUnits(line);
    if (need > available) {
      shortfalls.push({
        productSlug: slug,
        size,
        channel,
        requested: need,
        available,
      });
    }
  }

  if (!shortfalls.length) return;

  const detail = shortfalls
    .map(
      (s) =>
        `${s.productSlug} (${s.size}, ${s.channel}): need ${s.requested}, have ${s.available}`,
    )
    .join("; ");
  const err = new Error(`Insufficient stock: ${detail}`);
  err.statusCode = 409;
  err.stockShortfalls = shortfalls;
  throw err;
}

function assertValidCatalogLine(slug, size) {
  const productMap = getProductMap();
  const knownSizes = getKnownSizes();
  if (!productMap.has(slug)) {
    const e = new Error(`Unknown productSlug: ${slug}`);
    e.statusCode = 400;
    throw e;
  }
  if (!knownSizes.includes(size)) {
    const e = new Error(`Unknown size for this catalog: ${size}`);
    e.statusCode = 400;
    throw e;
  }
}

function ensureLine(index, slug, size, channel) {
  const key = stockLineKey(slug, size, channel);
  let line = index.get(key);
  if (!line) {
    const productMap = getProductMap();
    const productName = productMap.get(slug)?.name || null;
    line = {
      productSlug: slug,
      size,
      channel,
      productName,
      sku: null,
      active: true,
      track: false,
      onHand: 0,
      reserved: 0,
      incoming: 0,
      damaged: 0,
      reorderThreshold: null,
      updatedAt: null,
    };
    if (channel === "case") {
      line.originalCartons = null;
    }
    if (channel === "box") {
      line.originalBoxes = null;
    }
  } else if (!line.productName) {
    const productMap = getProductMap();
    line.productName = productMap.get(slug)?.name || null;
  }
  index.set(key, line);
  return { key, line };
}

/**
 * Website order paid — reserve physical demand (reserved only).
 */
export function reserveStockForWebsiteOrderItems(items, meta = {}) {
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    let wrote = false;

    for (const [key, qty] of demand) {
      const parts = key.split("\t");
      const slug = parts[0];
      const size = parts[1];
      const channel = parts[2];
      const need = Math.max(0, Math.floor(Number(qty) || 0));
      if (need < 1) continue;

      const line = index.get(key);
      if (!line || !line.track || line.active === false) continue;

      const before = inventorySnapshot(line);
      line.reserved = Math.max(0, line.reserved + need);
      touchLine(line);
      index.set(key, line);
      wrote = true;
      logVariantMovement({
        line,
        actionType: "reserve_order",
        quantityDelta: need,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || "Website order paid",
        referenceType: "order",
        referenceId: meta.orderId,
        adminUser: meta.adminUser || null,
      });
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: 2,
        lines: indexToSortedLines(index),
      });
    }
    return { ok: true, wrote };
  });
}

/**
 * Shipped web order — decrement on_hand and reserved by fulfilled demand.
 */
export function fulfillWebsiteOrderShippedStock(items, meta = {}) {
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    let wrote = false;

    for (const [key, qty] of demand) {
      const parts = key.split("\t");
      const slug = parts[0];
      const size = parts[1];
      const channel = parts[2];
      const need = Math.max(0, Math.floor(Number(qty) || 0));
      if (need < 1) continue;

      const line = index.get(key);
      if (!line || !line.track || line.active === false) continue;

      const before = inventorySnapshot(line);
      const dropReserve = Math.min(need, line.reserved);
      line.onHand = Math.max(0, line.onHand - need);
      line.reserved = Math.max(0, line.reserved - dropReserve);
      touchLine(line);
      index.set(key, line);
      wrote = true;
      logVariantMovement({
        line,
        actionType: "ship_order",
        quantityDelta: -need,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || "Order marked shipped",
        referenceType: "order",
        referenceId: meta.orderId,
        adminUser: meta.adminUser || null,
      });
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: 2,
        lines: indexToSortedLines(index),
      });
    }
    return { ok: true, wrote };
  });
}

/**
 * Walk-in / cash sale — reduce on_hand only (no reservation step).
 */
export function decrementWalkInPaidStock(items, meta = {}) {
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    let wrote = false;

    for (const [key, qty] of demand) {
      const parts = key.split("\t");
      const slug = parts[0];
      const size = parts[1];
      const channel = parts[2];
      const need = Math.max(0, Math.floor(Number(qty) || 0));
      if (need < 1) continue;

      const line = index.get(key);
      if (!line || !line.track || line.active === false) continue;

      const before = inventorySnapshot(line);
      const next = Math.max(0, line.onHand - need);
      if (next !== line.onHand) wrote = true;
      line.onHand = next;
      touchLine(line);
      index.set(key, line);
      logVariantMovement({
        line,
        actionType: "walk_in_sale",
        quantityDelta: -need,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || "Walk-in order paid",
        referenceType: "order",
        referenceId: meta.orderId,
        adminUser: meta.adminUser || null,
      });
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: 2,
        lines: indexToSortedLines(index),
      });
    }
    return { ok: true, wrote };
  });
}

/**
 * Shipped orders that never reserved web stock (e.g. manual phone orders) — on_hand only.
 */
export function decrementOnHandForShippedItems(items, meta = {}) {
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    let wrote = false;

    for (const [key, qty] of demand) {
      const parts = key.split("\t");
      const slug = parts[0];
      const size = parts[1];
      const channel = parts[2];
      const need = Math.max(0, Math.floor(Number(qty) || 0));
      if (need < 1) continue;

      const line = index.get(key);
      if (!line || !line.track || line.active === false) continue;

      const before = inventorySnapshot(line);
      const next = Math.max(0, line.onHand - need);
      if (next !== line.onHand) wrote = true;
      line.onHand = next;
      touchLine(line);
      index.set(key, line);
      logVariantMovement({
        line,
        actionType: "ship_order_non_web",
        quantityDelta: -need,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || "Order marked shipped (non-web)",
        referenceType: "order",
        referenceId: meta.orderId,
        adminUser: meta.adminUser || null,
      });
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: 2,
        lines: indexToSortedLines(index),
      });
    }
    return { ok: true, wrote };
  });
}

/** @deprecated */
export function decrementStockForPaidOrderItems(items) {
  return decrementOnHandForShippedItems(items, { reason: "Legacy decrement" });
}

/**
 * Release reserved units (e.g. paid order cancelled before ship). Does not change on_hand.
 */
export function releaseReservedStockForOrderItems(items, meta = {}) {
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    let wrote = false;

    for (const [key, qty] of demand) {
      const parts = key.split("\t");
      const slug = parts[0];
      const size = parts[1];
      const channel = parts[2];
      const need = Math.max(0, Math.floor(Number(qty) || 0));
      if (need < 1) continue;

      const line = index.get(key);
      if (!line || !line.track || line.active === false) continue;

      const before = inventorySnapshot(line);
      const drop = Math.min(need, line.reserved);
      if (drop < 1) continue;
      line.reserved = Math.max(0, line.reserved - drop);
      touchLine(line);
      index.set(key, line);
      wrote = true;
      logVariantMovement({
        line,
        actionType: "release_order",
        quantityDelta: -drop,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || "Order cancelled / release reservation",
        referenceType: "order",
        referenceId: meta.orderId,
        adminUser: meta.adminUser || null,
      });
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: 2,
        lines: indexToSortedLines(index),
      });
    }
    return { ok: true, wrote };
  });
}

/**
 * Staff inventory corrections (absolute set, delta, reserved, track, SKU, damaged, incoming).
 * @param {object[]} patches
 * @param {{ adminUser?: string|null, reason?: string }} [meta]
 */
export function applyAdminStockPatches(patches, meta = {}) {
  const list = Array.isArray(patches) ? patches : [];
  if (!list.length) {
    const e = new Error("Provide a non-empty `patches` array.");
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);

    for (const raw of list) {
      if (!raw || typeof raw !== "object") {
        const e = new Error("Each patch must be an object.");
        e.statusCode = 400;
        throw e;
      }
      const slug = String(raw.productSlug || "").trim();
      const size = String(raw.size || "").trim();
      const channel = normaliseChannel(raw.channel);
      if (!slug || !size || !channel) {
        const e = new Error("Each patch needs productSlug, size, and channel (case|box).");
        e.statusCode = 400;
        throw e;
      }
      assertValidCatalogLine(slug, size);

      const { key, line } = ensureLine(index, slug, size, channel);
      const before = inventorySnapshot(line);

      if (raw.track === true) {
        line.track = true;
      } else if (raw.track === false) {
        line.track = false;
      }

      if (raw.active === true) {
        line.active = true;
      } else if (raw.active === false) {
        line.active = false;
      }

      if (raw.sku != null) {
        line.sku = String(raw.sku).trim() || null;
      }

      if (raw.productName != null) {
        line.productName = String(raw.productName).trim() || null;
      }

      if (raw.reorderThreshold === null || raw.reorderThreshold === "") {
        line.reorderThreshold = null;
      } else if (raw.reorderThreshold !== undefined) {
        line.reorderThreshold = Math.max(0, Math.floor(Number(raw.reorderThreshold)));
      }

      if (raw.setReserved != null && raw.setReserved !== "") {
        line.reserved = Math.max(0, Math.floor(Number(raw.setReserved)));
      }

      if (raw.setOnHand != null && raw.setOnHand !== "") {
        line.onHand = Math.max(0, Math.floor(Number(raw.setOnHand)));
      }

      if (raw.addOnHand != null && raw.addOnHand !== "") {
        line.onHand = Math.max(0, line.onHand + Math.floor(Number(raw.addOnHand)));
      }

      if (raw.setIncoming != null && raw.setIncoming !== "") {
        line.incoming = Math.max(0, Math.floor(Number(raw.setIncoming)));
      }

      if (raw.addIncoming != null && raw.addIncoming !== "") {
        line.incoming = Math.max(0, line.incoming + Math.floor(Number(raw.addIncoming)));
      }

      if (raw.addDamaged != null && raw.addDamaged !== "") {
        line.damaged = Math.max(0, line.damaged + Math.floor(Number(raw.addDamaged)));
      }

      if (raw.setDamaged != null && raw.setDamaged !== "") {
        line.damaged = Math.max(0, Math.floor(Number(raw.setDamaged)));
      }

      if (channel === "case" && raw.originalCartons !== undefined) {
        if (raw.originalCartons === null || raw.originalCartons === "") {
          line.originalCartons = null;
        } else {
          line.originalCartons = Math.max(0, Math.floor(Number(raw.originalCartons)));
        }
      }

      if (channel === "box" && raw.originalBoxes !== undefined) {
        if (raw.originalBoxes === null || raw.originalBoxes === "") {
          line.originalBoxes = null;
        } else {
          line.originalBoxes = Math.max(0, Math.floor(Number(raw.originalBoxes)));
        }
      }

      touchLine(line);
      index.set(key, line);

      const after = inventorySnapshot(line);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        logVariantMovement({
          line,
          actionType: "admin_patch",
          quantityDelta: after.onHand - before.onHand,
          before,
          after,
          reason: meta.reason || raw.reason || "Admin stock patch",
          referenceType: "manual",
          referenceId: null,
          adminUser: meta.adminUser || null,
        });
      }
    }

    const nextPayload = {
      schemaVersion: 2,
      lines: indexToSortedLines(index),
    };
    writeStockPayload(nextPayload);
    return nextPayload;
  });
}

function recomputeShipmentStatus(sh) {
  const lines = Array.isArray(sh.lines) ? sh.lines : [];
  let total = 0;
  let recv = 0;
  for (const ln of lines) {
    total += Math.max(0, Math.floor(Number(ln.expectedQty) || 0));
    recv += Math.max(0, Math.floor(Number(ln.receivedQty) || 0));
  }
  if (recv <= 0) sh.status = "open";
  else if (recv >= total && total > 0) sh.status = "closed";
  else sh.status = "partial";
}

/**
 * @param {{ eta?: string|null, notes?: string, lines: { productSlug: string, size: string, unit: string, expectedQty: number }[] }} body
 */
export function createIncomingShipmentRecord(body, meta = {}) {
  const linesIn = Array.isArray(body?.lines) ? body.lines : [];
  if (!linesIn.length) {
    const e = new Error("Shipment needs at least one line.");
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return runStockMutation(() => {
    const shipData = readIncomingShipments();
    const shipments = Array.isArray(shipData.shipments) ? [...shipData.shipments] : [];
    const stockData = readStockData();
    const index = buildStockLineIndex(stockData);

    const id = newShipmentId();
    const now = new Date().toISOString();
    const lines = [];

    for (const raw of linesIn) {
      const slug = String(raw.productSlug || "").trim();
      const size = String(raw.size || "").trim();
      const channel = normaliseChannel(raw.unit || raw.channel);
      const expectedQty = Math.max(0, Math.floor(Number(raw.expectedQty) || 0));
      if (!slug || !size || !channel || expectedQty < 1) {
        const e = new Error("Each shipment line needs productSlug, size, unit (case|box), and expectedQty.");
        e.statusCode = 400;
        throw e;
      }
      assertValidCatalogLine(slug, size);
      const { key, line } = ensureLine(index, slug, size, channel);
      const before = inventorySnapshot(line);
      line.incoming = Math.max(0, line.incoming + expectedQty);
      touchLine(line);
      index.set(key, line);
      logVariantMovement({
        line,
        actionType: "incoming_expected",
        quantityDelta: expectedQty,
        before,
        after: inventorySnapshot(line),
        reason: meta.reason || `Incoming shipment ${id}`,
        referenceType: "shipment",
        referenceId: id,
        adminUser: meta.adminUser || null,
      });
      lines.push({
        id: newShipmentLineId(),
        productSlug: slug,
        size,
        unit: channel,
        expectedQty,
        receivedQty: 0,
      });
    }

    writeStockPayload({
      schemaVersion: 2,
      lines: indexToSortedLines(index),
    });

    const shipment = {
      id,
      status: "open",
      eta: body.eta != null ? String(body.eta).trim() || null : null,
      notes: body.notes != null ? String(body.notes).trim() || null : null,
      createdAt: now,
      updatedAt: now,
      lines,
    };
    recomputeShipmentStatus(shipment);
    shipments.push(shipment);
    writeIncomingShipments({ schemaVersion: 1, shipments });

    return { shipment, stock: readStockData() };
  });
}

/**
 * Receive stock from a shipment line into on_hand.
 */
export function receiveIncomingShipmentStock({ shipmentId, lineId, qty, adminUser, reason }) {
  const sid = String(shipmentId || "").trim();
  const lid = String(lineId || "").trim();
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (!sid || !lid || q < 1) {
    const e = new Error("shipmentId, lineId, and positive qty are required.");
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return runStockMutation(() => {
    const shipData = readIncomingShipments();
    const shipments = Array.isArray(shipData.shipments) ? shipData.shipments : [];
    const sh = shipments.find((s) => s.id === sid);
    if (!sh) {
      const e = new Error("Shipment not found.");
      e.statusCode = 404;
      throw e;
    }
    const ln = Array.isArray(sh.lines) ? sh.lines.find((l) => l.id === lid) : null;
    if (!ln) {
      const e = new Error("Shipment line not found.");
      e.statusCode = 404;
      throw e;
    }

    const expected = Math.max(0, Math.floor(Number(ln.expectedQty) || 0));
    const already = Math.max(0, Math.floor(Number(ln.receivedQty) || 0));
    const remaining = Math.max(0, expected - already);
    const recv = Math.min(q, remaining);
    if (recv < 1) {
      const e = new Error("Nothing left to receive on this line.");
      e.statusCode = 400;
      throw e;
    }

    const slug = String(ln.productSlug || "").trim();
    const size = String(ln.size || "").trim();
    const channel = normaliseChannel(ln.unit || ln.channel);
    assertValidCatalogLine(slug, size);

    const stockData = readStockData();
    const index = buildStockLineIndex(stockData);
    const { key, line } = ensureLine(index, slug, size, channel);

    const incomingBefore = line.incoming;
    if (incomingBefore < recv) {
      const e = new Error("Variant incoming count is lower than receive quantity; data may be out of sync.");
      e.statusCode = 409;
      throw e;
    }

    const before = inventorySnapshot(line);
    line.incoming = Math.max(0, line.incoming - recv);
    line.onHand = Math.max(0, line.onHand + recv);
    ln.receivedQty = already + recv;
    sh.updatedAt = new Date().toISOString();
    recomputeShipmentStatus(sh);
    touchLine(line);
    index.set(key, line);

    logVariantMovement({
      line,
      actionType: "receive_shipment",
      quantityDelta: recv,
      before,
      after: inventorySnapshot(line),
      reason: reason || `Received ${recv} from shipment ${sid}`,
      referenceType: "shipment",
      referenceId: sid,
      adminUser: adminUser || null,
    });

    writeStockPayload({
      schemaVersion: 2,
      lines: indexToSortedLines(index),
    });
    writeIncomingShipments({ schemaVersion: 1, shipments });

    return { shipment: sh, line: ln, received: recv, stock: readStockData() };
  });
}

const DEFAULT_BOXES_PER_CARTON = 10;

function boxesPerCartonForProduct(product) {
  const n = Number(product?.boxesPerCase);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_BOXES_PER_CARTON;
}

/**
 * Sellable units for a finite tracked line; `null` if missing, inactive, or not tracked.
 */
function sellableLeft(line) {
  if (!line || line.active === false || !line.track) return null;
  return Math.max(0, line.onHand - line.reserved);
}

/**
 * Dashboard overview: summary metrics + product → size rows for the admin inventory page.
 */
export function buildInventoryDashboardOverview() {
  const stockPayload = readStockData();
  const index = buildStockLineIndex(stockPayload);
  const knownSizes = getKnownSizes();
  const store = loadStore();
  const products = Array.isArray(store?.products) ? store.products : [];

  let totalCartonsLeft = 0;
  let totalBoxesLeft = 0;
  let totalCartonsSoldSum = 0;
  let hasAnyCartonSoldBaseline = false;
  let totalBoxesSoldSum = 0;
  let hasAnyBoxSoldBaseline = false;
  let activeVariantRows = 0;

  const productGroups = [];

  for (const product of products) {
    const slug = String(product?.slug || "").trim();
    if (!slug) continue;
    const productName = product?.name ? String(product.name) : slug;
    const bpc = boxesPerCartonForProduct(product);

    const sizesOut = [];
    let subCartonsLeft = 0;
    let subBoxesLeft = 0;
    let subEquiv = 0;
    let subCartonsSoldSum = 0;
    let subCartonsSoldHasBaseline = false;
    let subBoxesSoldSum = 0;
    let subBoxesSoldHasBaseline = false;

    for (const size of knownSizes) {
      const sizeStr = String(size || "").trim();
      if (!sizeStr) continue;

      const caseLine = index.get(stockLineKey(slug, sizeStr, "case")) || null;
      const boxLine = index.get(stockLineKey(slug, sizeStr, "box")) || null;
      if (!caseLine && !boxLine) continue;

      const cLeft = sellableLeft(caseLine);
      const bLeft = sellableLeft(boxLine);

      if (cLeft != null) {
        totalCartonsLeft += cLeft;
        subCartonsLeft += cLeft;
      }
      if (bLeft != null) {
        totalBoxesLeft += bLeft;
        subBoxesLeft += bLeft;
      }

      const cartonsOnHand = caseLine ? Math.max(0, Math.floor(caseLine.onHand)) : 0;
      const boxesOnHand = boxLine ? Math.max(0, Math.floor(boxLine.onHand)) : 0;

      const orig =
        caseLine && caseLine.originalCartons != null && Number.isFinite(caseLine.originalCartons)
          ? Math.max(0, Math.floor(caseLine.originalCartons))
          : null;
      let cartonsSold = null;
      if (orig != null && caseLine) {
        hasAnyCartonSoldBaseline = true;
        subCartonsSoldHasBaseline = true;
        cartonsSold = Math.max(0, orig - cartonsOnHand);
        totalCartonsSoldSum += cartonsSold;
        subCartonsSoldSum += cartonsSold;
      }

      const origBox =
        boxLine && boxLine.originalBoxes != null && Number.isFinite(boxLine.originalBoxes)
          ? Math.max(0, Math.floor(boxLine.originalBoxes))
          : null;
      let boxesSold = null;
      if (origBox != null && boxLine) {
        hasAnyBoxSoldBaseline = true;
        subBoxesSoldHasBaseline = true;
        boxesSold = Math.max(0, origBox - boxesOnHand);
        totalBoxesSoldSum += boxesSold;
        subBoxesSoldSum += boxesSold;
      }

      const cartonEquiv =
        cLeft == null && bLeft == null ? null : (cLeft ?? 0) + (bLeft ?? 0) / bpc;
      if (cartonEquiv != null) {
        subEquiv += cartonEquiv;
      }

      activeVariantRows += 1;

      sizesOut.push({
        size: sizeStr,
        boxesPerCarton: bpc,
        cartonsOnHand,
        boxesOnHand,
        cartonsLeft: cLeft,
        boxesLeft: bLeft,
        cartonEquivalent:
          cartonEquiv == null ? null : Math.round(cartonEquiv * 1000) / 1000,
        originalCartons: orig,
        cartonsSold,
        originalBoxes: origBox,
        boxesSold,
      });
    }

    if (!sizesOut.length) continue;

    productGroups.push({
      productSlug: slug,
      productName,
      boxesPerCarton: bpc,
      subtotal: {
        cartonsLeft: subCartonsLeft,
        boxesLeft: subBoxesLeft,
        cartonEquivalent: Math.round(subEquiv * 1000) / 1000,
        cartonsSold: subCartonsSoldHasBaseline ? subCartonsSoldSum : null,
        boxesSold: subBoxesSoldHasBaseline ? subBoxesSoldSum : null,
      },
      sizes: sizesOut,
    });
  }

  const lineCount = Array.isArray(stockPayload?.lines) ? stockPayload.lines.length : 0;

  return {
    summary: {
      totalCartonsLeft,
      totalBoxesLeft,
      totalCartonsSold: hasAnyCartonSoldBaseline ? totalCartonsSoldSum : null,
      totalBoxesSold: hasAnyBoxSoldBaseline ? totalBoxesSoldSum : null,
      activeVariantRows,
      stockLineCount: lineCount,
    },
    products: productGroups,
  };
}

export function readInventoryDashboardPayload() {
  const stockPayload = readStockData();
  const index = buildStockLineIndex(stockPayload);
  const lines = [...index.values()].map((line) => {
    const avail = availableUnits(line);
    return {
      ...publicInventoryLine(line),
      availableFinite: Number.isFinite(avail) ? avail : null,
    };
  });

  let onHandTotal = 0;
  let availableTotal = 0;
  let reservedTotal = 0;
  let incomingTotal = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  for (const row of lines) {
    onHandTotal += row.onHand;
    reservedTotal += row.reserved;
    incomingTotal += row.incoming;
    if (row.track && row.active !== false) {
      if (row.available != null) availableTotal += row.available;
      if (row.status === "Low stock") lowStockCount += 1;
      if (row.status === "Out of stock") outOfStockCount += 1;
    }
  }

  const shipments = readIncomingShipments();
  const movements = tailInventoryMovements(60);

  return {
    summary: {
      onHandTotal,
      availableTotal,
      reservedTotal,
      incomingTotal,
      lowStockCount,
      outOfStockCount,
    },
    variants: lines,
    movements,
    shipments: Array.isArray(shipments.shipments) ? shipments.shipments : [],
  };
}

