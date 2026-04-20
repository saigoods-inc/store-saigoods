import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectPhysicalStockDemands } from "./quote.js";
import { getProductMap, getKnownSizes } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Inventory lives beside the merchandising catalog (`data/store.json`).
 *
 * Each line is one stock-keeping row: product + size + channel (case vs box).
 * Bundle SKUs in the cart still consume case/box counts per size; `bundleId`
 * is intentionally omitted here so pricing bundles and physical stock stay decoupled.
 *
 * Fields:
 * - productSlug (string, required)
 * - size (string, required — must match `site.sizes` for sized gloves)
 * - channel: "case" | "box"
 * - track (boolean): when false or line missing, checkout does not block
 * - onHand, reserved (non-negative integers)
 * - sku, lowStockThreshold (optional)
 *
 * Writes: tracked lines decrement when staff marks an order shipped (`markAdminOrderHandoffShipped`)
 * or when a walk-in sale is recorded paid (`markWalkInOrderPaid` — no shipping step). Staff
 * can adjust counts via `POST /api/admin/stock` (`applyAdminStockPatches`). Serialized with
 * `runStockMutation` to avoid torn writes. Set `STOCK_AUTO_DECREMENT=false` to disable
 * automatic subtraction (availability checks still apply when `track` is true).
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
      return { schemaVersion: 1, lines: [] };
    }
    if (!Array.isArray(parsed.lines)) {
      return { ...parsed, lines: [] };
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { schemaVersion: 1, lines: [] };
    }
    throw err;
  }
}

/** Serialize mutations so concurrent checkouts do not corrupt `stock.json`. */
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
      };
      if (line.track === true) {
        o.track = true;
      }
      if (line.sku) {
        o.sku = line.sku;
      }
      if (line.lowStockThreshold != null && line.lowStockThreshold !== "") {
        o.lowStockThreshold = line.lowStockThreshold;
      }
      return o;
    });
}

function normaliseChannel(raw) {
  const c = String(raw || "").toLowerCase();
  if (c === "case" || c === "cases") return "case";
  if (c === "box" || c === "boxes") return "box";
  return null;
}

function stockLineKey(slug, size, channel) {
  return `${String(slug)}\t${String(size)}\t${String(channel)}`;
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
    map.set(key, {
      productSlug: slug,
      size,
      channel,
      sku: line.sku != null ? String(line.sku) : null,
      track: line.track === true,
      onHand: Math.max(0, Math.floor(Number(line.onHand) || 0)),
      reserved: Math.max(0, Math.floor(Number(line.reserved) || 0)),
      lowStockThreshold:
        line.lowStockThreshold == null || line.lowStockThreshold === ""
          ? null
          : Math.max(0, Math.floor(Number(line.lowStockThreshold))),
    });
  }
  return map;
}

function availableUnits(line) {
  if (!line || !line.track) return Number.POSITIVE_INFINITY;
  return Math.max(0, line.onHand - line.reserved);
}

function publicInventoryLine(line) {
  const avail = availableUnits(line);
  return {
    productSlug: line.productSlug,
    size: line.size,
    channel: line.channel,
    sku: line.sku,
    track: line.track,
    onHand: line.onHand,
    reserved: line.reserved,
    available: Number.isFinite(avail) ? avail : null,
    lowStockThreshold: line.lowStockThreshold,
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
    inventorySchemaVersion: 1,
    products: products.map((p) => ({
      ...p,
      inventory: {
        schemaVersion: 1,
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
    if (!line || !line.track) continue;
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

/**
 * Subtract fulfilled case/box counts from tracked lines (order line snapshot).
 * Set `STOCK_AUTO_DECREMENT=false` to disable writes (checks still run when `track` is true).
 * @param {Array} items — same shape as order `items` / quote rows (`slug`, `quantities`, `boxQuantities`, `bundleLines`)
 * @returns {Promise<{ ok: boolean, wrote?: boolean, skipped?: boolean }>}
 */
export function decrementStockForPaidOrderItems(items) {
  if (process.env.STOCK_AUTO_DECREMENT === "false") {
    return Promise.resolve({ ok: true, skipped: true });
  }

  return runStockMutation(() => {
    const data = readStockData();
    const index = buildStockLineIndex(data);
    const demand = collectPhysicalStockDemands(items);
    let wrote = false;

    for (const [key, qty] of demand) {
      const line = index.get(key);
      if (!line || !line.track) {
        continue;
      }
      const before = line.onHand;
      const next = Math.max(0, before - qty);
      if (next !== before) {
        wrote = true;
      }
      line.onHand = next;
      index.set(key, line);
    }

    if (wrote) {
      writeStockPayload({
        schemaVersion: data.schemaVersion || 1,
        lines: indexToSortedLines(index),
      });
    }

    return { ok: true, wrote };
  });
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

/**
 * Staff inventory corrections (absolute set, delta, reserved, track, SKU).
 * @param {object[]} patches
 * @returns {Promise<object>}
 */
export function applyAdminStockPatches(patches) {
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

      const key = stockLineKey(slug, size, channel);
      let line = index.get(key);
      if (!line) {
        line = {
          productSlug: slug,
          size,
          channel,
          sku: null,
          track: false,
          onHand: 0,
          reserved: 0,
          lowStockThreshold: null,
        };
      }

      if (raw.track === true) {
        line.track = true;
      } else if (raw.track === false) {
        line.track = false;
      }

      if (raw.sku != null) {
        line.sku = String(raw.sku).trim() || null;
      }

      if (raw.lowStockThreshold === null || raw.lowStockThreshold === "") {
        line.lowStockThreshold = null;
      } else if (raw.lowStockThreshold !== undefined) {
        line.lowStockThreshold = Math.max(0, Math.floor(Number(raw.lowStockThreshold)));
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

      index.set(key, line);
    }

    const nextPayload = {
      schemaVersion: data.schemaVersion || 1,
      lines: indexToSortedLines(index),
    };
    writeStockPayload(nextPayload);
    return nextPayload;
  });
}
