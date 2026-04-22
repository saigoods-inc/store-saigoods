import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { atomicWriteFileUtf8, getMutableDataDir, seedMutableDataFromBundle } from "./data-dir.js";

export function getIncomingShipmentsPath() {
  seedMutableDataFromBundle();
  return path.join(getMutableDataDir(), "incoming-shipments.json");
}

export function readIncomingShipments() {
  const filePath = getIncomingShipmentsPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { schemaVersion: 1, shipments: [] };
    }
    if (!Array.isArray(parsed.shipments)) {
      return { ...parsed, shipments: [] };
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { schemaVersion: 1, shipments: [] };
    }
    throw err;
  }
}

export function writeIncomingShipments(payload) {
  const target = getIncomingShipmentsPath();
  atomicWriteFileUtf8(target, `${JSON.stringify(payload, null, 2)}\n`);
}

export function newShipmentLineId() {
  return `sline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newShipmentId() {
  return `ship_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
