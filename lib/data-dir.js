import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Bundled `data/` from the deployment (often read-only on Vercel serverless). */
export const BUNDLED_DATA_DIR = path.join(__dirname, "..", "data");

let _resolvedMutableDir = null;
let _seededFromBundle = false;
let _warnedEphemeral = false;

function isLikelyServerlessReadOnlyBundle() {
  return process.env.VERCEL === "1" || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Directory for mutable JSON: `stock.json`, `inventory-movements.json`, `incoming-shipments.json`.
 * - Local / VPS: repo `data/` (default).
 * - Vercel / Lambda: `/tmp/saigoods-data` (writable); seeded once from the bundled `data/` copy.
 * - Override anytime: `SAIGOODS_DATA_DIR=/absolute/path`.
 *
 * Note: `/tmp` is per-instance and ephemeral across deploys and cold starts; for durable
 * inventory on serverless, point `SAIGOODS_DATA_DIR` at a mounted volume or migrate to a database.
 */
export function getMutableDataDir() {
  if (_resolvedMutableDir) {
    return _resolvedMutableDir;
  }
  const fromEnv = (process.env.SAIGOODS_DATA_DIR || "").trim();
  if (fromEnv) {
    _resolvedMutableDir = path.resolve(fromEnv);
    return _resolvedMutableDir;
  }
  if (isLikelyServerlessReadOnlyBundle()) {
    _resolvedMutableDir = path.join(os.tmpdir(), "saigoods-data");
    return _resolvedMutableDir;
  }
  _resolvedMutableDir = BUNDLED_DATA_DIR;
  return _resolvedMutableDir;
}

/** Copy bundled stock/movements/shipment files into the writable dir once (no overwrite). */
export function seedMutableDataFromBundle() {
  const dir = getMutableDataDir();
  if (dir === BUNDLED_DATA_DIR) {
    return;
  }
  if (_seededFromBundle) {
    return;
  }
  _seededFromBundle = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn("[data-dir] mkdir mutable data dir failed:", dir, e?.message || e);
    return;
  }
  const files = ["stock.json", "inventory-movements.json", "incoming-shipments.json"];
  for (const name of files) {
    const dest = path.join(dir, name);
    const src = path.join(BUNDLED_DATA_DIR, name);
    try {
      if (!fs.existsSync(dest) && fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    } catch (e) {
      console.warn("[data-dir] seed copy failed:", name, e?.message || e);
    }
  }
  if (!_warnedEphemeral && isLikelyServerlessReadOnlyBundle() && !(process.env.SAIGOODS_DATA_DIR || "").trim()) {
    _warnedEphemeral = true;
    console.warn(
      "[data-dir] Using ephemeral /tmp for mutable inventory files. Set SAIGOODS_DATA_DIR to a persistent path for production.",
    );
  }
}

/**
 * Write UTF-8 text to `targetPath` atomically when possible.
 * Temp file lives in `os.tmpdir()` so creation never hits read-only `/var/task/data`.
 */
export function atomicWriteFileUtf8(targetPath, body) {
  const tmp = path.join(
    os.tmpdir(),
    `.saigoods-${path.basename(targetPath, path.extname(targetPath))}-${process.pid}-${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, body, "utf8");
  try {
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    if (e && (e.code === "EXDEV" || e.code === "EPERM" || e.code === "EROFS")) {
      try {
        fs.copyFileSync(tmp, targetPath);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
