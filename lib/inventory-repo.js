import { dbSizeLabelsMatchingCatalogSize } from "./size-labels.js";
import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

/**
 * @returns {Promise<object[]>} joined rows: variant + product + inventory_levels (stable without PostgREST embed quirks)
 */
export async function fetchVariantInventoryRows() {
  const sb = getSupabaseServiceRoleClient();
  const { data: variants, error: vErr } = await sb
    .from("product_variants")
    .select("id, size_label, sku, boxes_per_case, gloves_per_box, track_inventory, active, product_id");
  if (vErr) {
    throw vErr;
  }
  const { data: products, error: pErr } = await sb.from("products").select("id, slug, name, active");
  if (pErr) {
    throw pErr;
  }
  const prodMap = new Map((products || []).map((p) => [p.id, p]));
  const vList = (variants || []).filter((v) => prodMap.has(v.product_id));
  const ids = vList.map((v) => v.id);
  /** @type {Map<string, object>} */
  let lvlMap = new Map();
  if (ids.length) {
    const { data: levels, error: lErr } = await sb.from("inventory_levels").select("*").in("variant_id", ids);
    if (lErr) {
      throw lErr;
    }
    lvlMap = new Map((levels || []).map((l) => [l.variant_id, l]));
  }
  return vList.map((v) => ({
    ...v,
    products: prodMap.get(v.product_id),
    inventory_levels: lvlMap.has(v.id) ? [lvlMap.get(v.id)] : [],
  }));
}

export async function fetchMovementTail(limit = 80) {
  const sb = getSupabaseServiceRoleClient();
  const n = Math.max(1, Math.floor(Number(limit) || 80));
  const { data, error } = await sb
    .from("inventory_movements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(n);

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Recent physical stock override audit rows (admin_set + physical_stock_override).
 * @param {number} [limit]
 */
export async function fetchStockOverrideMovements(limit = 25) {
  const sb = getSupabaseServiceRoleClient();
  const n = Math.max(1, Math.floor(Number(limit) || 25));
  const { data, error } = await sb
    .from("inventory_movements")
    .select(
      "id, variant_id, movement_type, reference_type, reference_id, cases_delta, boxes_delta, note, created_by, created_at",
    )
    .eq("movement_type", "admin_set")
    .eq("reference_type", "physical_stock_override")
    .order("created_at", { ascending: false })
    .limit(n);

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

export async function findVariantIdBySlugAndSize(slug, sizeLabel) {
  return findVariantIdBySlugAndCatalogSize(slug, sizeLabel);
}

/**
 * Resolve a variant by slug + logical size (S/M/L/XL), matching legacy DB labels (Small, …).
 */
export async function findVariantIdBySlugAndCatalogSize(slug, catalogOrDbSizeLabel) {
  const labels = dbSizeLabelsMatchingCatalogSize(catalogOrDbSizeLabel);
  if (!labels.length) {
    return null;
  }
  const sb = getSupabaseServiceRoleClient();
  const { data: prod, error: e1 } = await sb.from("products").select("id").eq("slug", slug).maybeSingle();
  if (e1) {
    throw e1;
  }
  if (!prod?.id) {
    return null;
  }
  const { data: rows, error: e2 } = await sb
    .from("product_variants")
    .select("id")
    .eq("product_id", prod.id)
    .in("size_label", labels)
    .limit(1);
  if (e2) {
    throw e2;
  }
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  return first?.id || null;
}

/**
 * @param {object[]} ops see `inventory_apply_ops` SQL
 */
export async function rpcInventoryApplyOps(ops) {
  const sb = getSupabaseServiceRoleClient();
  const { error } = await sb.rpc("inventory_apply_ops", { p_ops: ops });
  if (error) {
    throw error;
  }
}

/**
 * Atomically receive an arrived incoming batch (inventory_apply_ops + line totals + batch status).
 * Requires SQL migration `patch-incoming-batch-receive-rpc.sql`.
 *
 * @param {string} batchId
 * @param {{ line_id: string, received_cases: number, received_boxes: number }[]} lineReceipts
 * @param {string | null} actor
 * @param {string | null} note
 */
export async function rpcIncomingBatchReceive(batchId, lineReceipts, actor, note) {
  const sb = getSupabaseServiceRoleClient();
  const { error } = await sb.rpc("incoming_batch_receive", {
    p_batch_id: batchId,
    p_line_receipts: lineReceipts,
    p_actor: actor ?? null,
    p_note: note ?? null,
  });
  if (error) {
    const msg = error.message || "Incoming batch receive failed.";
    const err = new Error(msg);
    const lower = msg.toLowerCase();
    if (
      lower.includes("already been received") ||
      lower.includes("batch not found") ||
      lower.includes("cancelled batch") ||
      lower.includes("must be in arrived") ||
      lower.includes("exactly") ||
      lower.includes("duplicate line_id") ||
      lower.includes("missing line_id") ||
      lower.includes("unknown line_id") ||
      lower.includes("invalid line_id") ||
      lower.includes("no inventory variant") ||
      lower.includes("no lines to receive") ||
      lower.includes("at least one received") ||
      lower.includes("non-negative")
    ) {
      err.statusCode = 400;
    } else {
      err.statusCode = 500;
    }
    throw err;
  }
}
