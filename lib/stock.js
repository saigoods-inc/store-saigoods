import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileUtf8, getMutableDataDir, seedMutableDataFromBundle } from "./data-dir.js";
import * as inventoryService from "./inventory-service.js";
import { collectPhysicalStockDemands } from "./quote.js";
import { appendInventoryMovement, readInventoryMovements, tailInventoryMovements } from "./inventory-movements.js";
import {
  newShipmentId,
  newShipmentLineId,
  readIncomingShipments,
  writeIncomingShipments,
} from "./inventory-shipments.js";
import { fetchInventoryDashboardOrderMetrics } from "./inventory-dashboard-metrics.js";
import { catalogSizeFromDbSizeLabel } from "./size-labels.js";
import { getProductMap, getSupportedSizesForProduct, loadStore } from "./store.js";
import { isSupabaseInventoryBackend } from "./supabase-admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Variant-level inventory (`data/stock.json`) + movement log (`data/inventory-movements.json`)
 * + incoming shipments (`data/incoming-shipments.json`).
 *
 * File backend (legacy): website paid orders reserve demand on `markOrderPaid` (reserved↑, on_hand unchanged).
 * Shipped (handoff): on_hand↓ and reserved↓ by fulfilled demand (case/box channels).
 *
 * Supabase backend (default when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set; override with
 * `INVENTORY_BACKEND=file` for local JSON): stock is decremented when the web order is marked paid
 * (no reservation). Shipment handoff does not decrement web inventory again.
 */

export function getStockPath() {
  seedMutableDataFromBundle();
  return path.join(getMutableDataDir(), "stock.json");
}

/** Unified snapshot for merge / quotes / admin (file or Supabase). */
export async function readInventorySnapshot() {
  if (isSupabaseInventoryBackend()) {
    return inventoryService.readStockSnapshotFromDatabase();
  }
  return readStockDataFromFile();
}

export function readStockDataFromFile() {
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

/** @deprecated Use {@link readInventorySnapshot} (async) for callers that support both backends. */
export function readStockData() {
  if (isSupabaseInventoryBackend()) {
    throw new Error("readStockData() is file-backend only. Use readInventorySnapshot() with await.");
  }
  return readStockDataFromFile();
}

/** Serialize mutations so concurrent checkouts do not corrupt inventory files. */
let stockWriteChain = Promise.resolve();

export function runStockMutation(fn) {
  const next = stockWriteChain.then(() => Promise.resolve(fn()));
  stockWriteChain = next.catch((err) => {
    console.error("[stock] serialized mutation failed:", err);
  });
  return next;
}

function writeStockPayload(payload) {
  const target = getStockPath();
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  atomicWriteFileUtf8(target, body);
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

function groupedDemandByVariantBoxes(demand) {
  const grouped = new Map();
  for (const [key, qty] of demand || []) {
    const parts = key.split("\t");
    const slug = parts[0];
    const size = parts[1];
    const channel = parts[2];
    const need = Math.max(0, Math.floor(Number(qty) || 0));
    if (!slug || !size || need < 1) continue;
    const vKey = `${slug}\t${size}`;
    const cur = grouped.get(vKey) || { productSlug: slug, size, caseUnits: 0, boxUnits: 0 };
    if (channel === "case") cur.caseUnits += need;
    if (channel === "box") cur.boxUnits += need;
    grouped.set(vKey, cur);
  }
  return grouped;
}

function trackedLine(line) {
  return Boolean(line && line.track && line.active !== false);
}

function sellableBoxesForVariant(caseLine, boxLine, boxesPerCase) {
  let tracked = false;
  let total = 0;
  if (trackedLine(caseLine)) {
    tracked = true;
    total += Math.max(0, Math.floor(availableUnits(caseLine))) * boxesPerCase;
  }
  if (trackedLine(boxLine)) {
    tracked = true;
    total += Math.max(0, Math.floor(availableUnits(boxLine)));
  }
  return tracked ? total : null;
}

function normalizeBoxesToCaseLoose(totalBoxes, boxesPerCase) {
  const total = Math.max(0, Math.floor(Number(totalBoxes) || 0));
  const bpc = Math.max(1, Math.floor(Number(boxesPerCase) || 1));
  return {
    cases: Math.floor(total / bpc),
    boxes: total % bpc,
  };
}

function applyFungibleOnHandDecrementFile(index, demand, meta = {}, actionType = "stock_decrement", opts = {}) {
  const productMap = getProductMap();
  const grouped = groupedDemandByVariantBoxes(demand);
  let wrote = false;
  const dropReservedBoxes = opts.dropReservedBoxes === true;
  const rejectInsufficient = opts.rejectInsufficient === true;

  for (const row of grouped.values()) {
    const product = productMap.get(row.productSlug);
    if (!product) continue;
    const bpc = boxesPerCartonForProduct(product);
    const needBoxes = row.caseUnits * bpc + row.boxUnits;
    if (needBoxes < 1) continue;

    const caseKey = stockLineKey(row.productSlug, row.size, "case");
    const boxKey = stockLineKey(row.productSlug, row.size, "box");
    const caseLine = index.get(caseKey) || null;
    const boxLine = index.get(boxKey) || null;
    if (!trackedLine(caseLine) && !trackedLine(boxLine)) continue;

    const caseBefore = caseLine ? inventorySnapshot(caseLine) : null;
    const boxBefore = boxLine ? inventorySnapshot(boxLine) : null;

    const onHandCases = caseLine ? Math.max(0, Math.floor(caseLine.onHand || 0)) : 0;
    const onHandBoxes = boxLine ? Math.max(0, Math.floor(boxLine.onHand || 0)) : 0;
    const totalBoxesBefore = onHandCases * bpc + onHandBoxes;
    if (rejectInsufficient && needBoxes > totalBoxesBefore) {
      const e = new Error("Insufficient stock to complete this walk-in order.");
      e.statusCode = 409;
      e.stockShortfalls = [
        {
          productSlug: row.productSlug,
          size: row.size,
          channel: "shared",
          requested: needBoxes,
          available: totalBoxesBefore,
        },
      ];
      throw e;
    }
    const totalBoxesAfter = Math.max(0, totalBoxesBefore - needBoxes);
    const nextOnHand = normalizeBoxesToCaseLoose(totalBoxesAfter, bpc);

    if (caseLine) {
      caseLine.onHand = nextOnHand.cases;
    }
    if (boxLine) {
      boxLine.onHand = nextOnHand.boxes;
    }

    if (dropReservedBoxes) {
      const beforeReservedCases = caseLine ? Math.max(0, Math.floor(caseLine.reserved || 0)) : 0;
      const beforeReservedBoxes = boxLine ? Math.max(0, Math.floor(boxLine.reserved || 0)) : 0;
      const totalReservedBoxesBefore = beforeReservedCases * bpc + beforeReservedBoxes;
      const totalReservedBoxesAfter = Math.max(0, totalReservedBoxesBefore - Math.min(needBoxes, totalReservedBoxesBefore));
      const nextReserved = normalizeBoxesToCaseLoose(totalReservedBoxesAfter, bpc);
      if (caseLine) caseLine.reserved = nextReserved.cases;
      if (boxLine) boxLine.reserved = nextReserved.boxes;
    }

    if (caseLine) {
      touchLine(caseLine);
      index.set(caseKey, caseLine);
      const after = inventorySnapshot(caseLine);
      if (JSON.stringify(caseBefore) !== JSON.stringify(after)) {
        wrote = true;
        logVariantMovement({
          line: caseLine,
          actionType,
          quantityDelta: after.onHand - (caseBefore?.onHand ?? 0),
          before: caseBefore || {},
          after,
          reason: meta.reason || "",
          referenceType: "order",
          referenceId: meta.orderId,
          adminUser: meta.adminUser || null,
        });
      }
    }
    if (boxLine) {
      touchLine(boxLine);
      index.set(boxKey, boxLine);
      const after = inventorySnapshot(boxLine);
      if (JSON.stringify(boxBefore) !== JSON.stringify(after)) {
        wrote = true;
        logVariantMovement({
          line: boxLine,
          actionType,
          quantityDelta: after.onHand - (boxBefore?.onHand ?? 0),
          before: boxBefore || {},
          after,
          reason: meta.reason || "",
          referenceType: "order",
          referenceId: meta.orderId,
          adminUser: meta.adminUser || null,
        });
      }
    }
  }

  return wrote;
}

function fileWalkInSaleAlreadyCommitted(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return false;
  const { entries } = readInventoryMovements();
  return (entries || []).some(
    (e) =>
      String(e?.actionType || "") === "walk_in_sale" &&
      String(e?.referenceType || "") === "order" &&
      String(e?.referenceId || "") === id,
  );
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

export async function mergeInventoryIntoStore(storePayload) {
  const globalOos = Boolean(storePayload?.site?.storefrontGlobalOutOfStock);
  const stockPayload = await readInventorySnapshot();
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
    site: {
      ...(storePayload.site && typeof storePayload.site === "object" ? storePayload.site : {}),
      storefrontGlobalOutOfStock: globalOos,
    },
    products: products.map((p) => {
      let lines = bySlug.get(p.slug) || [];
      if (globalOos) {
        lines = lines.map((l) => ({
          ...l,
          onHand: 0,
          reserved: 0,
          incoming: 0,
          damaged: 0,
          available: 0,
          status: "Out of stock",
        }));
      }
      return {
        ...p,
        inventory: {
          schemaVersion: 2,
          lines,
          globalOutOfStock: globalOos,
        },
      };
    }),
  };
}

export async function mergeInventoryIntoProduct(product) {
  if (!product || typeof product !== "object") return product;
  const merged = await mergeInventoryIntoStore({ products: [product] });
  const next = merged.products[0];
  return next || product;
}

/**
 * @throws {Error & { statusCode?: number, stockShortfalls?: object[] }}
 */
export async function assertStockAvailableForItems(items) {
  const list = Array.isArray(items) ? items : [];
  const store = loadStore();
  if (store?.site?.storefrontGlobalOutOfStock && list.length > 0) {
    const err = new Error("This product is currently out of stock. We're restocking soon.");
    err.statusCode = 409;
    err.stockShortfalls = [
      {
        productSlug: "_storefront",
        size: "_",
        channel: "_",
        requested: 1,
        available: 0,
      },
    ];
    throw err;
  }

  const demand = collectPhysicalStockDemands(list);
  const index = buildStockLineIndex(await readInventorySnapshot());
  const shortfalls = [];

  const grouped = groupedDemandByVariantBoxes(demand);
  const productMap = getProductMap();
  for (const row of grouped.values()) {
    const product = productMap.get(row.productSlug);
    if (!product) continue;
    const bpc = boxesPerCartonForProduct(product);
    const needBoxes = row.caseUnits * bpc + row.boxUnits;
    const caseLine = index.get(stockLineKey(row.productSlug, row.size, "case")) || null;
    const boxLine = index.get(stockLineKey(row.productSlug, row.size, "box")) || null;
    const availableBoxes = sellableBoxesForVariant(caseLine, boxLine, bpc);
    if (availableBoxes == null) continue;
    if (needBoxes > availableBoxes) {
      shortfalls.push({
        productSlug: row.productSlug,
        size: row.size,
        channel: "shared",
        requested: needBoxes,
        available: availableBoxes,
      });
    }
  }

  if (!shortfalls.length) return;

  const err = new Error("Sorry. We are out of stock. Check back soon.");
  err.statusCode = 409;
  err.stockShortfalls = shortfalls;
  throw err;
}

function assertValidCatalogLine(slug, size) {
  const productMap = getProductMap();
  const product = productMap.get(slug);
  if (!product) {
    const e = new Error(`Unknown productSlug: ${slug}`);
    e.statusCode = 400;
    throw e;
  }
  const sizeKey = catalogSizeFromDbSizeLabel(size);
  const allowed = getSupportedSizesForProduct(product);
  if (!allowed.includes(sizeKey)) {
    const e = new Error(`Unknown size for this product: ${size}`);
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
  if (isSupabaseInventoryBackend()) {
    return Promise.resolve({ ok: true, skipped: true, reason: "inventory_backend_supabase" });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockDataFromFile();
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
  if (isSupabaseInventoryBackend()) {
    return Promise.resolve({ ok: true, skipped: true, reason: "web_inventory_decremented_on_payment" });
  }
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockDataFromFile();
    const index = buildStockLineIndex(data);
    let wrote = false;

    wrote = applyFungibleOnHandDecrementFile(index, demand, meta, "ship_order", { dropReservedBoxes: true });

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
 * Rejects insufficient stock (does not silently clamp).
 * Idempotent for file backend when walk_in_sale movements already exist for orderId.
 */
export function decrementWalkInPaidStock(items, meta = {}) {
  if (isSupabaseInventoryBackend()) {
    return runStockMutation(() => inventoryService.commitWalkInPaidDecrement(items, meta));
  }
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const orderId = meta.orderId != null ? String(meta.orderId) : null;
    if (orderId && fileWalkInSaleAlreadyCommitted(orderId)) {
      return { ok: true, skipped: true, idempotent: true };
    }

    const data = readStockDataFromFile();
    const index = buildStockLineIndex(data);
    const wrote = applyFungibleOnHandDecrementFile(index, demand, meta, "walk_in_sale", {
      rejectInsufficient: true,
    });

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
  if (isSupabaseInventoryBackend()) {
    return runStockMutation(() => inventoryService.commitNonWebShippedDecrement(items, meta));
  }
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockDataFromFile();
    const index = buildStockLineIndex(data);
    let wrote = false;

    wrote = applyFungibleOnHandDecrementFile(index, demand, meta, "ship_order_non_web");

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
  if (isSupabaseInventoryBackend()) {
    return Promise.resolve({ ok: true, skipped: true, reason: "no_reservations_in_supabase_mode" });
  }
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) return Promise.resolve({ ok: true, skipped: true });

  return runStockMutation(() => {
    const data = readStockDataFromFile();
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
 * @param {{ adminUser?: string|null, reason?: string, source?: string|null, overrideNote?: string|null }} [meta]
 */
export function applyAdminStockPatches(patches, meta = {}) {
  const list = Array.isArray(patches) ? patches : [];
  if (!list.length) {
    const e = new Error("Provide a non-empty `patches` array.");
    e.statusCode = 400;
    return Promise.reject(e);
  }

  if (isSupabaseInventoryBackend()) {
    return runStockMutation(() => inventoryService.applyAdminStockPatchesDb(list, meta));
  }

  return runStockMutation(() => {
    const data = readStockDataFromFile();
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
  if (isSupabaseInventoryBackend()) {
    const e = new Error(
      "Incoming shipments are not wired for Supabase inventory yet. Use manual stock / restock adjustments instead.",
    );
    e.statusCode = 501;
    return Promise.reject(e);
  }
  const linesIn = Array.isArray(body?.lines) ? body.lines : [];
  if (!linesIn.length) {
    const e = new Error("Shipment needs at least one line.");
    e.statusCode = 400;
    return Promise.reject(e);
  }

  return runStockMutation(() => {
    const shipData = readIncomingShipments();
    const shipments = Array.isArray(shipData.shipments) ? [...shipData.shipments] : [];
    const stockData = readStockDataFromFile();
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

    return { shipment, stock: readStockDataFromFile() };
  });
}

/**
 * Receive stock from a shipment line into on_hand.
 */
export function receiveIncomingShipmentStock({ shipmentId, lineId, qty, adminUser, reason }) {
  if (isSupabaseInventoryBackend()) {
    const e = new Error(
      "Receiving incoming shipments is not wired for Supabase inventory yet. Use manual stock / restock adjustments instead.",
    );
    e.statusCode = 501;
    return Promise.reject(e);
  }
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

    const stockData = readStockDataFromFile();
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

    return { shipment: sh, line: ln, received: recv, stock: readStockDataFromFile() };
  });
}

/**
 * Web order paid: reserve (file backend) or decrement immediately (Supabase).
 */
export function commitWebsiteOrderStockOnPayment(items, meta = {}) {
  if (isSupabaseInventoryBackend()) {
    return runStockMutation(() => inventoryService.commitWebsiteOrderPaymentDecrement(items, meta));
  }
  return reserveStockForWebsiteOrderItems(items, meta);
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

function formatInventoryAvailabilityPhrase(cases, boxes) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  if (c === 0 && b === 0) {
    return "0 available";
  }
  const parts = [];
  if (c > 0) {
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (b > 0) {
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return `${parts.join(", ")} available`;
}

/**
 * Operational inventory alerts for Business Summary (not date-range scoped).
 * Uses sellable box-equivalent (on_hand − reserved per tracked channel), same basis as inventory health.
 *
 * @param {Awaited<ReturnType<typeof buildInventoryEditorGrid>>} editor
 * @param {ReturnType<typeof buildStockLineIndex>} index
 */
export function collectInventoryAlertsFromEditor(editor, index) {
  const outOfStock = [];
  const lowInventory = [];
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];

  for (const g of groups) {
    const slug = String(g.productSlug || "").trim();
    const bpc = Math.max(1, Math.floor(Number(g.boxesPerCase) || 10));
    const productName = String(g.catalogProductName || g.productSlug || slug).trim() || slug;
    const list = Array.isArray(g.rows) ? g.rows : [];

    for (const r of list) {
      const size = String(r.size || "").trim();
      if (!slug || !size) {
        continue;
      }

      const caseLine = index.get(stockLineKey(slug, size, "case")) || null;
      const boxLine = index.get(stockLineKey(slug, size, "box")) || null;
      if (!trackedLine(caseLine) && !trackedLine(boxLine)) {
        continue;
      }

      const sellable = sellableBoxesForVariant(caseLine, boxLine, bpc);
      if (sellable == null) {
        continue;
      }

      const { cases, boxes } = normalizeBoxesToCaseLoose(sellable, bpc);
      const displayText = `${productName} / ${size}: ${formatInventoryAvailabilityPhrase(cases, boxes)}`;
      const row = {
        productSlug: slug,
        size,
        productName,
        displayText,
        availableCases: cases,
        availableBoxes: boxes,
      };

      if (sellable <= 0) {
        outOfStock.push(row);
      } else if (sellable <= bpc) {
        lowInventory.push(row);
      }
    }
  }

  const sortRows = (a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size);
  outOfStock.sort(sortRows);
  lowInventory.sort(sortRows);

  return {
    inventoryOutOfStock: { count: outOfStock.length, rows: outOfStock.slice(0, 15) },
    lowInventory: { count: lowInventory.length, rows: lowInventory.slice(0, 15) },
  };
}

/** @returns {Promise<{ inventoryOutOfStock: { count: number, rows: object[] }, lowInventory: { count: number, rows: object[] } }>} */
export async function buildSummaryInventoryAlerts() {
  const stockPayload = await readInventorySnapshot();
  const index = buildStockLineIndex(stockPayload);
  const editor = await buildInventoryEditorGrid();
  return collectInventoryAlertsFromEditor(editor, index);
}

/**
 * Dashboard overview: summary metrics for the admin inventory page (orders + physical on-hand).
 */
export async function buildInventoryDashboardOverview() {
  const stockPayload = await readInventorySnapshot();
  const index = buildStockLineIndex(stockPayload);
  const store = loadStore();
  const products = Array.isArray(store?.products) ? store.products : [];
  const storefrontGlobalOutOfStock = Boolean(store?.site?.storefrontGlobalOutOfStock);

  let remainingCases = 0;
  let remainingBoxes = 0;
  let activeVariantRows = 0;

  for (const product of products) {
    const slug = String(product?.slug || "").trim();
    if (!slug) {
      continue;
    }

    for (const size of getSupportedSizesForProduct(product)) {
      const sizeStr = String(size || "").trim();
      if (!sizeStr) {
        continue;
      }

      const caseLine = index.get(stockLineKey(slug, sizeStr, "case")) || null;
      const boxLine = index.get(stockLineKey(slug, sizeStr, "box")) || null;
      if (!caseLine && !boxLine) {
        continue;
      }

      activeVariantRows += 1;

      if (caseLine) {
        remainingCases += Math.max(0, Math.floor(Number(caseLine.onHand) || 0));
      }
      if (boxLine) {
        remainingBoxes += Math.max(0, Math.floor(Number(boxLine.onHand) || 0));
      }
    }
  }

  const lineCount = Array.isArray(stockPayload?.lines) ? stockPayload.lines.length : 0;

  let orderMetrics = {
    ok: false,
    soldCases: 0,
    soldBoxes: 0,
    soldMixedPackSizes: false,
    toShipCases: 0,
    toShipBoxes: 0,
    toShipMixedPackSizes: false,
  };
  try {
    orderMetrics = await fetchInventoryDashboardOrderMetrics();
  } catch (e) {
    console.error("[buildInventoryDashboardOverview] order metrics", e);
  }

  return {
    storefrontGlobalOutOfStock,
    summary: {
      remainingCases,
      remainingBoxes,
      soldCases: orderMetrics.soldCases ?? 0,
      soldBoxes: orderMetrics.soldBoxes ?? 0,
      soldMixedPackSizes: Boolean(orderMetrics.soldMixedPackSizes),
      toShipCases: orderMetrics.toShipCases ?? 0,
      toShipBoxes: orderMetrics.toShipBoxes ?? 0,
      toShipMixedPackSizes: Boolean(orderMetrics.toShipMixedPackSizes),
      orderMetricsAvailable: orderMetrics.ok === true,
      activeVariantRows,
      stockLineCount: lineCount,
    },
  };
}

/**
 * Every catalog product × site size for manual case/box on-hand entry in the admin UI.
 */
export async function buildInventoryEditorGrid() {
  const stockPayload = await readInventorySnapshot();
  const index = buildStockLineIndex(stockPayload);
  const store = loadStore();
  const products = Array.isArray(store?.products) ? store.products : [];
  const groups = [];
  for (const product of products) {
    const slug = String(product?.slug || "").trim();
    if (!slug) {
      continue;
    }
    const catalogName = product?.name ? String(product.name) : slug;
    const rows = [];
    for (const size of getSupportedSizesForProduct(product)) {
      const sizeStr = String(size || "").trim();
      if (!sizeStr) {
        continue;
      }
      const caseLine = index.get(stockLineKey(slug, sizeStr, "case")) || null;
      const boxLine = index.get(stockLineKey(slug, sizeStr, "box")) || null;
      rows.push({
        productSlug: slug,
        catalogProductName: catalogName,
        size: sizeStr,
        casesOnHand: caseLine ? Math.max(0, Math.floor(Number(caseLine.onHand) || 0)) : 0,
        boxesOnHand: boxLine ? Math.max(0, Math.floor(Number(boxLine.onHand) || 0)) : 0,
        trackCases: caseLine ? caseLine.track === true : false,
        trackBoxes: boxLine ? boxLine.track === true : false,
      });
    }
    if (rows.length) {
      groups.push({
        productSlug: slug,
        catalogProductName: catalogName,
        boxesPerCase: boxesPerCartonForProduct(product),
        rows,
      });
    }
  }
  return { groups };
}

export async function readInventoryDashboardPayload() {
  const stockPayload = await readInventorySnapshot();
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
  const productMap = getProductMap();
  const seen = new Set();

  for (const row of lines) {
    onHandTotal += row.onHand;
    reservedTotal += row.reserved;
    incomingTotal += row.incoming;
  }

  for (const product of productMap.values()) {
    const bpc = boxesPerCartonForProduct(product);
    for (const size of getSupportedSizesForProduct(product)) {
      const key = `${product.slug}\t${size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const caseLine = index.get(stockLineKey(product.slug, size, "case")) || null;
      const boxLine = index.get(stockLineKey(product.slug, size, "box")) || null;
      const sellableBoxes = sellableBoxesForVariant(caseLine, boxLine, bpc);
      if (sellableBoxes == null) continue;
      availableTotal += sellableBoxes;
      if (sellableBoxes <= 0) outOfStockCount += 1;
      else if (sellableBoxes <= bpc) lowStockCount += 1;
    }
  }

  const shipments = isSupabaseInventoryBackend()
    ? { schemaVersion: 1, shipments: [] }
    : readIncomingShipments();
  const movements = isSupabaseInventoryBackend()
    ? await inventoryService.fetchMovementHistoryMapped(60)
    : tailInventoryMovements(60);

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

