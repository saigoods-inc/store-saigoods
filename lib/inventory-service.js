import crypto from "node:crypto";

import { collectPhysicalStockDemands } from "./quote.js";
import { catalogSizeFromDbSizeLabel } from "./size-labels.js";
import { getProductMap, getSupportedSizesForProduct, loadStore } from "./store.js";
import { getSupabaseServiceRoleClient, isSupabaseInventoryBackend } from "./supabase-admin.js";
import * as repo from "./inventory-repo.js";

function lineKey(slug, size, channel) {
  return `${String(slug)}\t${String(size)}\t${String(channel)}`;
}

/**
 * @param {Awaited<ReturnType<typeof repo.fetchVariantInventoryRows>>} rows
 */
export function variantRowsToStockPayload(rows) {
  const lines = [];
  for (const row of rows) {
    const p = row.products;
    if (!p || p.active === false) {
      continue;
    }
    const slug = String(p.slug || "").trim();
    const productName = p.name != null ? String(p.name).trim() : slug;
    const size = catalogSizeFromDbSizeLabel(row.size_label);
    if (!slug || !size) {
      continue;
    }
    const lvlRaw = row.inventory_levels;
    const lvl = Array.isArray(lvlRaw) && lvlRaw.length ? lvlRaw[0] : null;
    const track = row.track_inventory === true && row.active !== false;
    const cases = lvl ? Math.max(0, Math.floor(Number(lvl.cases_on_hand) || 0)) : 0;
    const boxes = lvl ? Math.max(0, Math.floor(Number(lvl.boxes_loose_on_hand) || 0)) : 0;
    const incC = lvl ? Math.max(0, Math.floor(Number(lvl.incoming_cases) || 0)) : 0;
    const incB = lvl ? Math.max(0, Math.floor(Number(lvl.incoming_boxes) || 0)) : 0;
    const baseC =
      lvl && lvl.cases_baseline != null && Number.isFinite(Number(lvl.cases_baseline))
        ? Math.max(0, Math.floor(Number(lvl.cases_baseline)))
        : null;
    const baseB =
      lvl && lvl.boxes_baseline != null && Number.isFinite(Number(lvl.boxes_baseline))
        ? Math.max(0, Math.floor(Number(lvl.boxes_baseline)))
        : null;

    lines.push({
      productSlug: slug,
      size,
      channel: "case",
      productName,
      sku: row.sku != null ? String(row.sku) : null,
      active: row.active !== false,
      track,
      onHand: cases,
      reserved: 0,
      incoming: incC,
      damaged: 0,
      originalCartons: baseC,
      updatedAt: lvl?.updated_at || null,
    });
    lines.push({
      productSlug: slug,
      size,
      channel: "box",
      productName,
      sku: row.sku != null ? String(row.sku) : null,
      active: row.active !== false,
      track,
      onHand: boxes,
      reserved: 0,
      incoming: incB,
      damaged: 0,
      originalBoxes: baseB,
      updatedAt: lvl?.updated_at || null,
    });
  }

  return { schemaVersion: 2, lines };
}

export async function readStockSnapshotFromDatabase() {
  const rows = await repo.fetchVariantInventoryRows();
  return variantRowsToStockPayload(rows);
}

export async function fetchMovementHistoryMapped(limit = 80) {
  const raw = await repo.fetchMovementTail(limit);
  const variantIds = [...new Set(raw.map((r) => r.variant_id).filter(Boolean))];
  const meta = await fetchVariantSlugSizeMap(variantIds);

  return mapMovementRowsToHistory(raw, meta);
}

function parseOverrideMovementNote(note) {
  if (note == null) {
    return {};
  }
  if (typeof note === "object") {
    return note;
  }
  const t = String(note).trim();
  if (!t) {
    return {};
  }
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === "object" ? parsed : { overrideNote: t };
    } catch {
      return { overrideNote: t };
    }
  }
  return { overrideNote: t, reason: t };
}

function numOrNull(v) {
  if (v == null || v === "") {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * @param {Awaited<ReturnType<typeof repo.fetchStockOverrideMovements>>} raw
 */
function mapMovementRowsToOverrideHistory(raw, variantMeta) {
  const productMap = getProductMap();
  return raw.map((m) => {
    const v = variantMeta.get(m.variant_id) || {};
    const slug = v.slug || "";
    const size = catalogSizeFromDbSizeLabel(v.size_label || "");
    const product = slug ? productMap.get(slug) : null;
    const parsed = parseOverrideMovementNote(m.note);
    const deltaCases = numOrNull(parsed.deltaCases) ?? (Number(m.cases_delta) || 0);
    const deltaBoxes = numOrNull(parsed.deltaBoxes) ?? (Number(m.boxes_delta) || 0);
    return {
      id: m.id,
      referenceId: m.reference_id != null ? String(m.reference_id) : null,
      createdAt: m.created_at,
      createdBy: m.created_by || null,
      productSlug: slug,
      productName: product?.name ? String(product.name) : slug,
      size,
      oldCases: numOrNull(parsed.oldCases),
      oldBoxes: numOrNull(parsed.oldBoxes),
      newCases: numOrNull(parsed.newCases),
      newBoxes: numOrNull(parsed.newBoxes),
      deltaCases,
      deltaBoxes,
      overrideNote: parsed.overrideNote != null ? String(parsed.overrideNote) : null,
      reason: parsed.reason != null ? String(parsed.reason) : null,
    };
  });
}

export async function buildStockOverrideHistoryForAdminStock(limit = 25) {
  if (!isSupabaseInventoryBackend()) {
    return { overrides: [] };
  }
  const raw = await repo.fetchStockOverrideMovements(limit);
  const variantIds = [...new Set(raw.map((r) => r.variant_id).filter(Boolean))];
  const meta = await fetchVariantSlugSizeMap(variantIds);
  return { overrides: mapMovementRowsToOverrideHistory(raw, meta) };
}

function mapMovementRowsToHistory(raw, meta) {
  return raw.map((m) => {
    const v = meta.get(m.variant_id) || {};
    const slug = v.slug || "";
    const size = catalogSizeFromDbSizeLabel(v.size_label || "");
    const dc = Number(m.cases_delta) || 0;
    const db = Number(m.boxes_delta) || 0;
    const ch = dc !== 0 && db === 0 ? "case" : db !== 0 && dc === 0 ? "box" : "case";
    const qtyDelta = ch === "case" ? dc : db;
    const detailParts = [];
    if (dc) {
      detailParts.push(`cases ${dc}`);
    }
    if (db) {
      detailParts.push(`boxes ${db}`);
    }
    const actionType = dc && db ? `${m.movement_type} (${detailParts.join(", ")})` : m.movement_type;
    return {
      id: m.id,
      variantKey: lineKey(slug, size, ch),
      productSlug: slug,
      size,
      channel: ch,
      actionType,
      quantityDelta: qtyDelta,
      before: {},
      after: {},
      reason: [m.note || "", dc && db ? detailParts.join(" · ") : ""].filter(Boolean).join(" — "),
      referenceType: m.reference_type || null,
      referenceId: m.reference_id != null ? String(m.reference_id) : null,
      adminUser: m.created_by || null,
      createdAt: m.created_at,
    };
  });
}

async function fetchVariantSlugSizeMap(variantIds) {
  const map = new Map();
  if (!variantIds.length) {
    return map;
  }
  const sb = getSupabaseServiceRoleClient();
  const { data: variants, error: vErr } = await sb
    .from("product_variants")
    .select("id, size_label, product_id")
    .in("id", variantIds);
  if (vErr) {
    throw vErr;
  }
  const pids = [...new Set((variants || []).map((v) => v.product_id).filter(Boolean))];
  const { data: products, error: pErr } = await sb.from("products").select("id, slug").in("id", pids);
  if (pErr) {
    throw pErr;
  }
  const prodSlug = new Map((products || []).map((p) => [p.id, String(p.slug || "")]));
  for (const row of variants || []) {
    map.set(row.id, {
      slug: prodSlug.get(row.product_id) || "",
      size_label: String(row.size_label || ""),
    });
  }
  return map;
}

async function resolveVariantId(slug, sizeLabel) {
  return repo.findVariantIdBySlugAndCatalogSize(slug, sizeLabel);
}

/**
 * @param {Map<string, number>} demand from collectPhysicalStockDemands
 */
export async function applyDemandDeltas(demand, meta, movementType) {
  const sb = getSupabaseServiceRoleClient();
  const grouped = new Map();
  for (const [key, qty] of demand) {
    const parts = key.split("\t");
    const slug = parts[0];
    const size = parts[1];
    const channel = parts[2];
    const need = Math.max(0, Math.floor(Number(qty) || 0));
    if (!slug || !size || need < 1) continue;
    const vKey = `${slug}\t${size}`;
    const cur = grouped.get(vKey) || { slug, size, caseUnits: 0, boxUnits: 0 };
    if (channel === "case") cur.caseUnits += need;
    if (channel === "box") cur.boxUnits += need;
    grouped.set(vKey, cur);
  }

  const ops = [];
  for (const row of grouped.values()) {
    const vid = await resolveVariantId(row.slug, row.size);
    if (!vid) {
      continue;
    }
    const { data: vRow, error: vErr } = await sb
      .from("product_variants")
      .select("boxes_per_case")
      .eq("id", vid)
      .maybeSingle();
    if (vErr) throw vErr;
    const bpc = Math.max(1, Math.floor(Number(vRow?.boxes_per_case) || 10));

    const { data: lvl, error: lErr } = await sb
      .from("inventory_levels")
      .select("cases_on_hand, boxes_loose_on_hand")
      .eq("variant_id", vid)
      .maybeSingle();
    if (lErr) throw lErr;
    const curCases = Math.max(0, Math.floor(Number(lvl?.cases_on_hand) || 0));
    const curBoxes = Math.max(0, Math.floor(Number(lvl?.boxes_loose_on_hand) || 0));

    const needBoxes = row.caseUnits * bpc + row.boxUnits;
    if (needBoxes < 1) continue;
    const totalBoxesBefore = curCases * bpc + curBoxes;
    const totalBoxesAfter = Math.max(0, totalBoxesBefore - needBoxes);
    const nextCases = Math.floor(totalBoxesAfter / bpc);
    const nextBoxes = totalBoxesAfter % bpc;
    const dCases = nextCases - curCases;
    const dBoxes = nextBoxes - curBoxes;
    if (dCases !== 0 || dBoxes !== 0) {
      ops.push({
        variant_id: vid,
        cases_delta: dCases,
        boxes_delta: dBoxes,
        movement_type: movementType,
        note: meta.reason || "",
        reference_type: meta.referenceType || "order",
        reference_id: meta.orderId != null ? String(meta.orderId) : null,
        created_by: meta.adminUser || null,
      });
    }
  }
  if (ops.length) {
    await repo.rpcInventoryApplyOps(ops);
  }
}

export async function commitWebsiteOrderPaymentDecrement(items, meta) {
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) {
    return { ok: true, skipped: true };
  }
  await applyDemandDeltas(demand, { ...meta, referenceType: "order" }, "order_commit");
  return { ok: true, wrote: true };
}

export async function commitWalkInPaidDecrement(items, meta) {
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) {
    return { ok: true, skipped: true };
  }
  await applyDemandDeltas(demand, { ...meta, referenceType: "order" }, "walk_in_sale");
  return { ok: true, wrote: true };
}

export async function commitNonWebShippedDecrement(items, meta) {
  const demand = collectPhysicalStockDemands(items);
  if (!demand.size) {
    return { ok: true, skipped: true };
  }
  await applyDemandDeltas(demand, { ...meta, referenceType: "order" }, "non_web_shipment");
  return { ok: true, wrote: true };
}

function normaliseInventoryPatchChannel(raw) {
  const c = String(raw || "").toLowerCase();
  if (c === "case" || c === "cases") {
    return "case";
  }
  if (c === "box" || c === "boxes") {
    return "box";
  }
  return null;
}

/**
 * Physical stock editor saves: one admin_set movement per variant with JSON audit note.
 * @param {object[]} patches
 * @param {{ adminUser?: string|null, reason?: string, overrideNote?: string|null }} meta
 */
async function applyPhysicalStockOverridePatchesDb(patches, meta = {}) {
  const list = Array.isArray(patches) ? patches : [];
  const sb = getSupabaseServiceRoleClient();
  const referenceId = crypto.randomUUID();
  const overrideNote = meta.overrideNote != null ? String(meta.overrideNote).trim() || null : null;
  const reason = meta.reason || "Admin manual on-hand (cases & boxes)";
  const ops = [];

  /** @type {Map<string, { slug: string, sizeKey: string, casePatch?: object, boxPatch?: object, all: object[] }>} */
  const groups = new Map();

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      const e = new Error("Each patch must be an object.");
      e.statusCode = 400;
      throw e;
    }
    const slug = String(raw.productSlug || "").trim();
    const sizeRaw = String(raw.size || "").trim();
    const sizeKey = catalogSizeFromDbSizeLabel(sizeRaw);
    const channel = normaliseInventoryPatchChannel(raw.channel);
    if (!slug || !sizeKey || !channel) {
      const e = new Error("Each patch needs productSlug, size, and channel (case|box).");
      e.statusCode = 400;
      throw e;
    }

    const productMap = getProductMap();
    const product = productMap.get(slug);
    if (!product) {
      const e = new Error(`Unknown productSlug: ${slug}`);
      e.statusCode = 400;
      throw e;
    }
    const allowed = getSupportedSizesForProduct(product);
    if (!allowed.includes(sizeKey)) {
      const e = new Error(`Unknown size for this product: ${sizeRaw}`);
      e.statusCode = 400;
      throw e;
    }

    const key = `${slug}\t${sizeKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { slug, sizeKey, all: [] };
      groups.set(key, g);
    }
    g.all.push(raw);
    if (channel === "case") {
      g.casePatch = raw;
    } else {
      g.boxPatch = raw;
    }
  }

  for (const g of groups.values()) {
    const { slug, sizeKey } = g;
    let vid = await resolveVariantId(slug, sizeKey);
    if (!vid) {
      await ensureCatalogVariantAndLevel(slug, sizeKey);
      vid = await resolveVariantId(slug, sizeKey);
    }
    if (!vid) {
      const e = new Error(`Could not resolve variant for ${slug} / ${sizeKey}`);
      e.statusCode = 400;
      throw e;
    }

    for (const raw of g.all) {
      if (raw.track === false) {
        await sb.from("product_variants").update({ track_inventory: false, updated_at: new Date().toISOString() }).eq("id", vid);
      } else if (raw.track === true) {
        await sb.from("product_variants").update({ track_inventory: true, updated_at: new Date().toISOString() }).eq("id", vid);
      }
      if (raw.active === true || raw.active === false) {
        await sb
          .from("product_variants")
          .update({ active: raw.active !== false, updated_at: new Date().toISOString() })
          .eq("id", vid);
      }
      if (raw.sku != null) {
        await sb
          .from("product_variants")
          .update({ sku: String(raw.sku).trim() || null, updated_at: new Date().toISOString() })
          .eq("id", vid);
      }
      if (raw.productName != null) {
        const nm = String(raw.productName).trim();
        if (nm) {
          await sb.from("products").update({ name: nm, updated_at: new Date().toISOString() }).eq("slug", slug);
        }
      }
    }

    const { data: lvlRow, error: lvlErr } = await sb.from("inventory_levels").select("*").eq("variant_id", vid).maybeSingle();
    if (lvlErr) {
      throw lvlErr;
    }
    const curCases = Math.max(0, Math.floor(Number(lvlRow?.cases_on_hand) || 0));
    const curBoxes = Math.max(0, Math.floor(Number(lvlRow?.boxes_loose_on_hand) || 0));

    let nextCases = curCases;
    let nextBoxes = curBoxes;

    const casePatch = g.casePatch;
    if (casePatch) {
      if (casePatch.setOnHand != null && casePatch.setOnHand !== "") {
        nextCases = Math.max(0, Math.floor(Number(casePatch.setOnHand)));
      }
      if (casePatch.addOnHand != null && casePatch.addOnHand !== "") {
        nextCases = Math.max(0, curCases + Math.floor(Number(casePatch.addOnHand)));
      }
      if (casePatch.originalCartons !== undefined) {
        const v =
          casePatch.originalCartons === null || casePatch.originalCartons === ""
            ? null
            : Math.max(0, Math.floor(Number(casePatch.originalCartons)));
        await sb.from("inventory_levels").update({ cases_baseline: v, updated_at: new Date().toISOString() }).eq("variant_id", vid);
      }
    }

    const boxPatch = g.boxPatch;
    if (boxPatch) {
      if (boxPatch.setOnHand != null && boxPatch.setOnHand !== "") {
        nextBoxes = Math.max(0, Math.floor(Number(boxPatch.setOnHand)));
      }
      if (boxPatch.addOnHand != null && boxPatch.addOnHand !== "") {
        nextBoxes = Math.max(0, curBoxes + Math.floor(Number(boxPatch.addOnHand)));
      }
      if (boxPatch.originalBoxes !== undefined) {
        const v =
          boxPatch.originalBoxes === null || boxPatch.originalBoxes === ""
            ? null
            : Math.max(0, Math.floor(Number(boxPatch.originalBoxes)));
        await sb.from("inventory_levels").update({ boxes_baseline: v, updated_at: new Date().toISOString() }).eq("variant_id", vid);
      }
    }

    const dCases = nextCases - curCases;
    const dBoxes = nextBoxes - curBoxes;

    if (dCases !== 0 || dBoxes !== 0) {
      const notePayload = {
        oldCases: curCases,
        oldBoxes: curBoxes,
        newCases: nextCases,
        newBoxes: nextBoxes,
        deltaCases: dCases,
        deltaBoxes: dBoxes,
        overrideNote,
        reason,
      };
      ops.push({
        variant_id: vid,
        cases_delta: dCases,
        boxes_delta: dBoxes,
        movement_type: "admin_set",
        note: JSON.stringify(notePayload),
        reference_type: "physical_stock_override",
        reference_id: referenceId,
        created_by: meta.adminUser || null,
      });
    }
  }

  if (ops.length) {
    await repo.rpcInventoryApplyOps(ops);
  }

  return readStockSnapshotFromDatabase();
}

/**
 * @param {object[]} patches same shape as legacy applyAdminStockPatches
 * @param {{ adminUser?: string|null, reason?: string, source?: string|null, overrideNote?: string|null }} meta
 */
export async function applyAdminStockPatchesDb(patches, meta = {}) {
  const list = Array.isArray(patches) ? patches : [];
  if (meta.source === "physical_stock_override") {
    return applyPhysicalStockOverridePatchesDb(list, meta);
  }

  const sb = getSupabaseServiceRoleClient();
  const ops = [];

  const normaliseChannel = normaliseInventoryPatchChannel;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      const e = new Error("Each patch must be an object.");
      e.statusCode = 400;
      throw e;
    }
    const slug = String(raw.productSlug || "").trim();
    const sizeRaw = String(raw.size || "").trim();
    const sizeKey = catalogSizeFromDbSizeLabel(sizeRaw);
    const channel = normaliseChannel(raw.channel);
    if (!slug || !sizeKey || !channel) {
      const e = new Error("Each patch needs productSlug, size, and channel (case|box).");
      e.statusCode = 400;
      throw e;
    }

    const productMap = getProductMap();
    const product = productMap.get(slug);
    if (!product) {
      const e = new Error(`Unknown productSlug: ${slug}`);
      e.statusCode = 400;
      throw e;
    }
    const allowed = getSupportedSizesForProduct(product);
    if (!allowed.includes(sizeKey)) {
      const e = new Error(`Unknown size for this product: ${sizeRaw}`);
      e.statusCode = 400;
      throw e;
    }

    let vid = await resolveVariantId(slug, sizeKey);
    if (!vid) {
      await ensureCatalogVariantAndLevel(slug, sizeKey);
      vid = await resolveVariantId(slug, sizeKey);
    }
    if (!vid) {
      const e = new Error(`Could not resolve variant for ${slug} / ${sizeKey}`);
      e.statusCode = 400;
      throw e;
    }

    if (raw.track === false) {
      await sb.from("product_variants").update({ track_inventory: false, updated_at: new Date().toISOString() }).eq("id", vid);
    } else if (raw.track === true) {
      await sb.from("product_variants").update({ track_inventory: true, updated_at: new Date().toISOString() }).eq("id", vid);
    }

    if (raw.active === true || raw.active === false) {
      await sb
        .from("product_variants")
        .update({ active: raw.active !== false, updated_at: new Date().toISOString() })
        .eq("id", vid);
    }

    if (raw.sku != null) {
      await sb
        .from("product_variants")
        .update({ sku: String(raw.sku).trim() || null, updated_at: new Date().toISOString() })
        .eq("id", vid);
    }

    if (raw.productName != null) {
      const nm = String(raw.productName).trim();
      if (nm) {
        await sb.from("products").update({ name: nm, updated_at: new Date().toISOString() }).eq("slug", slug);
      }
    }

    const { data: lvlRow, error: lvlErr } = await sb.from("inventory_levels").select("*").eq("variant_id", vid).maybeSingle();
    if (lvlErr) {
      throw lvlErr;
    }
    const curCases = Math.max(0, Math.floor(Number(lvlRow?.cases_on_hand) || 0));
    const curBoxes = Math.max(0, Math.floor(Number(lvlRow?.boxes_loose_on_hand) || 0));

    let nextCases = curCases;
    let nextBoxes = curBoxes;
    if (channel === "case") {
      if (raw.setOnHand != null && raw.setOnHand !== "") {
        nextCases = Math.max(0, Math.floor(Number(raw.setOnHand)));
      }
      if (raw.addOnHand != null && raw.addOnHand !== "") {
        nextCases = Math.max(0, curCases + Math.floor(Number(raw.addOnHand)));
      }
    } else {
      if (raw.setOnHand != null && raw.setOnHand !== "") {
        nextBoxes = Math.max(0, Math.floor(Number(raw.setOnHand)));
      }
      if (raw.addOnHand != null && raw.addOnHand !== "") {
        nextBoxes = Math.max(0, curBoxes + Math.floor(Number(raw.addOnHand)));
      }
    }

    const dCases = nextCases - curCases;
    const dBoxes = nextBoxes - curBoxes;

    if (raw.originalCartons !== undefined && channel === "case") {
      const v =
        raw.originalCartons === null || raw.originalCartons === ""
          ? null
          : Math.max(0, Math.floor(Number(raw.originalCartons)));
      await sb.from("inventory_levels").update({ cases_baseline: v, updated_at: new Date().toISOString() }).eq("variant_id", vid);
    }
    if (raw.originalBoxes !== undefined && channel === "box") {
      const v =
        raw.originalBoxes === null || raw.originalBoxes === ""
          ? null
          : Math.max(0, Math.floor(Number(raw.originalBoxes)));
      await sb.from("inventory_levels").update({ boxes_baseline: v, updated_at: new Date().toISOString() }).eq("variant_id", vid);
    }

    if (dCases !== 0 || dBoxes !== 0) {
      ops.push({
        variant_id: vid,
        cases_delta: dCases,
        boxes_delta: dBoxes,
        movement_type: "manual_adjustment",
        note: meta.reason || raw.reason || "Admin stock patch",
        reference_type: "manual",
        reference_id: null,
        created_by: meta.adminUser || null,
      });
    }
  }

  if (ops.length) {
    await repo.rpcInventoryApplyOps(ops);
  }

  return readStockSnapshotFromDatabase();
}

async function ensureCatalogVariantAndLevel(slug, sizeLabel) {
  const sb = getSupabaseServiceRoleClient();
  const productMap = getProductMap();
  const p = productMap.get(slug);
  if (!p) {
    return;
  }

  const canon = catalogSizeFromDbSizeLabel(sizeLabel);

  const { data: prod, error: pe } = await sb.from("products").select("id").eq("slug", slug).maybeSingle();
  if (pe) {
    throw pe;
  }
  let productId = prod?.id;
  if (!productId) {
    const ins = await sb
      .from("products")
      .insert({
        slug,
        name: String(p.name || slug),
        category: null,
        active: true,
      })
      .select("id")
      .single();
    if (ins.error) {
      throw ins.error;
    }
    productId = ins.data.id;
  }

  const boxesPerCase = Math.max(1, Math.floor(Number(p.boxesPerCase) || 10));
  const existingId = await repo.findVariantIdBySlugAndCatalogSize(slug, canon);
  if (existingId) {
    const { data: lvl } = await sb.from("inventory_levels").select("id").eq("variant_id", existingId).maybeSingle();
    if (!lvl) {
      await sb.from("inventory_levels").insert({
        variant_id: existingId,
        cases_on_hand: 0,
        boxes_loose_on_hand: 0,
      });
    }
    return;
  }

  const vIns = await sb
    .from("product_variants")
    .insert({
      product_id: productId,
      size_label: canon,
      sku: null,
      boxes_per_case: boxesPerCase,
      gloves_per_box: null,
      track_inventory: true,
      active: true,
    })
    .select("id")
    .single();
  if (vIns.error) {
    throw vIns.error;
  }
  await sb.from("inventory_levels").insert({
    variant_id: vIns.data.id,
    cases_on_hand: 0,
    boxes_loose_on_hand: 0,
  });
}

/**
 * Bootstrap catalog variants + empty levels for every store product × site size (idempotent).
 */
export async function ensureAllCatalogVariants() {
  const store = loadStore();
  const products = Array.isArray(store?.products) ? store.products : [];
  for (const p of products) {
    const slug = String(p.slug || "").trim();
    if (!slug) {
      continue;
    }
    for (const size of getSupportedSizesForProduct(p)) {
      const sizeLabel = String(size || "").trim();
      if (!sizeLabel) {
        continue;
      }
      await ensureCatalogVariantAndLevel(slug, sizeLabel);
    }
  }
}
