import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { atomicWriteFileUtf8, getMutableDataDir, seedMutableDataFromBundle } from "./data-dir.js";

const MAX_ENTRIES = 5000;

export function getInventoryMovementsPath() {
  seedMutableDataFromBundle();
  return path.join(getMutableDataDir(), "inventory-movements.json");
}

export function readInventoryMovements() {
  const filePath = getInventoryMovementsPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { schemaVersion: 1, entries: [] };
    }
    if (!Array.isArray(parsed.entries)) {
      return { ...parsed, entries: [] };
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { schemaVersion: 1, entries: [] };
    }
    throw err;
  }
}

export function writeInventoryMovements(payload) {
  const target = getInventoryMovementsPath();
  atomicWriteFileUtf8(target, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * @param {object} entry
 * @param {string} entry.variantKey
 * @param {string} entry.actionType
 * @param {number} [entry.quantityDelta]
 * @param {object} entry.before
 * @param {object} entry.after
 * @param {string} [entry.reason]
 * @param {string|null} [entry.referenceType]
 * @param {string|null} [entry.referenceId]
 * @param {string|null} [entry.adminUser]
 */
export function appendInventoryMovement(entry) {
  const data = readInventoryMovements();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const row = {
    id: entry.id || crypto.randomUUID(),
    variantKey: String(entry.variantKey || ""),
    productSlug: entry.productSlug != null ? String(entry.productSlug) : "",
    size: entry.size != null ? String(entry.size) : "",
    channel: entry.channel != null ? String(entry.channel) : "",
    actionType: String(entry.actionType || "unknown"),
    quantityDelta:
      entry.quantityDelta != null && entry.quantityDelta !== "" ? Number(entry.quantityDelta) : null,
    before: entry.before && typeof entry.before === "object" ? entry.before : {},
    after: entry.after && typeof entry.after === "object" ? entry.after : {},
    reason: entry.reason != null ? String(entry.reason) : "",
    referenceType: entry.referenceType != null ? String(entry.referenceType) : null,
    referenceId: entry.referenceId != null ? String(entry.referenceId) : null,
    adminUser: entry.adminUser != null ? String(entry.adminUser) : null,
    createdAt: entry.createdAt || new Date().toISOString(),
  };
  entries.push(row);
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  writeInventoryMovements({ schemaVersion: data.schemaVersion || 1, entries: trimmed });
  return row;
}

export function tailInventoryMovements(limit = 80) {
  const { entries } = readInventoryMovements();
  const n = Math.max(1, Math.floor(Number(limit) || 80));
  return entries.slice(-n).reverse();
}
