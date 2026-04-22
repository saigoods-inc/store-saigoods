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

export async function findVariantIdBySlugAndSize(slug, sizeLabel) {
  const sb = getSupabaseServiceRoleClient();
  const { data: prod, error: e1 } = await sb.from("products").select("id").eq("slug", slug).maybeSingle();
  if (e1) {
    throw e1;
  }
  if (!prod?.id) {
    return null;
  }
  const { data: v, error: e2 } = await sb
    .from("product_variants")
    .select("id")
    .eq("product_id", prod.id)
    .eq("size_label", sizeLabel)
    .maybeSingle();
  if (e2) {
    throw e2;
  }
  return v?.id || null;
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
