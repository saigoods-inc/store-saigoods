/**
 * One-time bootstrap: seed `products`, `product_variants`, `inventory_levels` from local
 * `data/store.json` + optional `data/stock.json` (legacy file format).
 *
 * Usage (from repo root, with env set):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/bootstrap-inventory-from-json.mjs
 *
 * Loads `.env` from repo root when present. Does not start the web server.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { dbSizeLabelsMatchingCatalogSize } from "../lib/size-labels.js";
import { getSupportedSizesForProduct } from "../lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!existsSync(p)) {
    return;
  }
  const raw = readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) {
      continue;
    }
    const k = m[1].trim();
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (k && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

loadDotEnv();

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

function normaliseChannel(raw) {
  const c = String(raw || "").toLowerCase();
  if (c === "case" || c === "cases") {
    return "case";
  }
  if (c === "box" || c === "boxes") {
    return "box";
  }
  return null;
}

async function ensureProduct(slug, name) {
  const { data: existing, error: e1 } = await sb.from("products").select("id").eq("slug", slug).maybeSingle();
  if (e1) {
    throw e1;
  }
  if (existing?.id) {
    await sb.from("products").update({ name, active: true, updated_at: new Date().toISOString() }).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb
    .from("products")
    .insert({ slug, name, active: true })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  return data.id;
}

async function ensureVariant(productId, sizeLabel, boxesPerCase) {
  const labels = dbSizeLabelsMatchingCatalogSize(sizeLabel);
  const { data: rows, error: e1 } = await sb
    .from("product_variants")
    .select("id, size_label")
    .eq("product_id", productId)
    .in("size_label", labels)
    .limit(1);
  if (e1) {
    throw e1;
  }
  const existing = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (existing?.id) {
    await sb
      .from("product_variants")
      .update({
        size_label: String(sizeLabel || "").trim(),
        boxes_per_case: Math.max(1, Math.floor(Number(boxesPerCase) || 10)),
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await sb
    .from("product_variants")
    .insert({
      product_id: productId,
      size_label: sizeLabel,
      boxes_per_case: Math.max(1, Math.floor(Number(boxesPerCase) || 10)),
      track_inventory: true,
      active: true,
    })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  return data.id;
}

async function ensureLevel(variantId, cases, boxes, casesBaseline, boxesBaseline) {
  const { data: existing, error: e1 } = await sb.from("inventory_levels").select("id").eq("variant_id", variantId).maybeSingle();
  if (e1) {
    throw e1;
  }
  const row = {
    variant_id: variantId,
    cases_on_hand: Math.max(0, Math.floor(cases)),
    boxes_loose_on_hand: Math.max(0, Math.floor(boxes)),
    cases_baseline: casesBaseline != null ? Math.max(0, Math.floor(casesBaseline)) : null,
    boxes_baseline: boxesBaseline != null ? Math.max(0, Math.floor(boxesBaseline)) : null,
    updated_at: new Date().toISOString(),
  };
  if (existing?.id) {
    const { error } = await sb.from("inventory_levels").update(row).eq("id", existing.id);
    if (error) {
      throw error;
    }
  } else {
    const { error } = await sb.from("inventory_levels").insert(row);
    if (error) {
      throw error;
    }
  }
}

async function main() {
  const store = readJson("data/store.json");
  const products = Array.isArray(store?.products) ? store.products : [];

  let stock = { lines: [] };
  if (existsSync(path.join(root, "data", "stock.json"))) {
    stock = readJson("data/stock.json");
  }

  const bySlugSize = new Map();
  for (const line of stock.lines || []) {
    const slug = String(line.productSlug || "").trim();
    const size = String(line.size || "").trim();
    const ch = normaliseChannel(line.channel);
    if (!slug || !size || !ch) {
      continue;
    }
    const k = `${slug}\t${size}`;
    if (!bySlugSize.has(k)) {
      bySlugSize.set(k, { case: null, box: null });
    }
    bySlugSize.get(k)[ch] = line;
  }

  for (const p of products) {
    const slug = String(p.slug || "").trim();
    if (!slug) {
      continue;
    }
    const productId = await ensureProduct(slug, String(p.name || slug));
    const bpc = Math.max(1, Math.floor(Number(p.boxesPerCase) || 10));
    for (const size of getSupportedSizesForProduct(p)) {
      const sizeLabel = String(size || "").trim();
      if (!sizeLabel) {
        continue;
      }
      const variantId = await ensureVariant(productId, sizeLabel, bpc);
      let legacy = null;
      for (const lab of dbSizeLabelsMatchingCatalogSize(sizeLabel)) {
        legacy = bySlugSize.get(`${slug}\t${lab}`);
        if (legacy) {
          break;
        }
      }
      const caseLine = legacy?.case;
      const boxLine = legacy?.box;
      const cases = caseLine ? Math.max(0, Math.floor(Number(caseLine.onHand) || 0)) : 0;
      const boxes = boxLine ? Math.max(0, Math.floor(Number(boxLine.onHand) || 0)) : 0;
      const casesBaseline =
        caseLine && caseLine.originalCartons != null ? Math.max(0, Math.floor(Number(caseLine.originalCartons))) : null;
      const boxesBaseline =
        boxLine && boxLine.originalBoxes != null ? Math.max(0, Math.floor(Number(boxLine.originalBoxes))) : null;
      await ensureLevel(variantId, cases, boxes, casesBaseline ?? cases, boxesBaseline ?? boxes);
    }
  }

  console.log("Bootstrap complete: products, variants, and inventory_levels updated from JSON.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
