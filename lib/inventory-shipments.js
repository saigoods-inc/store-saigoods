import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getIncomingShipmentsPath() {
  return path.join(__dirname, "..", "data", "incoming-shipments.json");
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
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.incoming-shipments-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

export function newShipmentLineId() {
  return `sline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newShipmentId() {
  return `ship_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
