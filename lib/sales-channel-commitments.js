import { createClient } from "@supabase/supabase-js";

const COMMITMENT_STATUSES = new Set(["unshipped", "shipped", "cancelled"]);

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function mapActorEmail(actor) {
  if (!actor) {
    return null;
  }
  if (actor.kind === "user") {
    return actor.email || null;
  }
  if (actor.kind === "service") {
    return "internal";
  }
  return null;
}

/**
 * @param {{ status?: string, channel?: string } | undefined} filters
 */
export async function listSalesChannelCommitments(filters = {}) {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for sales channel commitments."), {
      statusCode: 503,
    });
  }

  let q = client.from("sales_channel_commitments").select("*").order("sold_at", { ascending: false, nullsFirst: false });

  const status = filters.status != null ? String(filters.status).trim() : "";
  if (status) {
    q = q.eq("status", status);
  }

  const channel = filters.channel != null ? String(filters.channel).trim() : "";
  if (channel) {
    q = q.eq("channel", channel);
  }

  const { data, error } = await q;
  if (error) {
    throw Object.assign(new Error(error.message || "Could not list sales channel commitments."), { statusCode: 500 });
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Sum unshipped quantities from row list (direct cases/boxes totals).
 * Mixed boxes-per-case across products is not normalized — same limitation as simple KPI sums.
 *
 * @param {object[]} rows
 * @returns {{ summary: { unshippedCases: number, unshippedBoxes: number }, byChannel: Record<string, { unshippedCases: number, unshippedBoxes: number }> }}
 */
export function aggregateUnshippedCommitmentRows(rows) {
  let unshippedCases = 0;
  let unshippedBoxes = 0;
  /** @type {Record<string, { unshippedCases: number, unshippedBoxes: number }>} */
  const byChannel = {};

  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    const c = Math.max(0, Math.floor(Number(r.quantity_cases) || 0));
    const b = Math.max(0, Math.floor(Number(r.quantity_boxes) || 0));
    const ch = String(r.channel || "unknown").trim() || "unknown";

    unshippedCases += c;
    unshippedBoxes += b;

    if (!byChannel[ch]) {
      byChannel[ch] = { unshippedCases: 0, unshippedBoxes: 0 };
    }
    byChannel[ch].unshippedCases += c;
    byChannel[ch].unshippedBoxes += b;
  }

  return {
    summary: { unshippedCases, unshippedBoxes },
    byChannel,
  };
}

/**
 * @returns {Promise<{ summary: { unshippedCases: number, unshippedBoxes: number }, byChannel: Record<string, { unshippedCases: number, unshippedBoxes: number }> }>}
 */
export async function fetchSalesChannelCommitmentDemand() {
  const rows = await listSalesChannelCommitments({ status: "unshipped" });
  return aggregateUnshippedCommitmentRows(rows);
}

/**
 * Payload for GET /api/admin-stock (Phase 1): unshipped rows + aggregates.
 */
export async function buildSalesChannelCommitmentsPayloadForAdminStock() {
  const client = getServiceClient();
  if (!client) {
    return {
      rows: [],
      summary: { unshippedCases: 0, unshippedBoxes: 0 },
      byChannel: {},
    };
  }

  try {
    const rows = await listSalesChannelCommitments({ status: "unshipped" });
    const { summary, byChannel } = aggregateUnshippedCommitmentRows(rows);
    return {
      rows,
      summary,
      byChannel,
    };
  } catch (e) {
    console.error("[sales-channel-commitments] buildSalesChannelCommitmentsPayloadForAdminStock", e);
    return {
      rows: [],
      summary: { unshippedCases: 0, unshippedBoxes: 0 },
      byChannel: {},
    };
  }
}

function normaliseCommitmentInput(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const channelRaw = String(o.channel ?? o.salesChannel ?? "").trim();
  const channel = channelRaw || "amazon_fbm";

  const external_order_id =
    o.external_order_id != null
      ? String(o.external_order_id).trim() || null
      : o.externalOrderId != null
        ? String(o.externalOrderId).trim() || null
        : null;

  const product_slug = String(o.product_slug ?? o.productSlug ?? "").trim();
  const size = String(o.size ?? "").trim();

  const quantity_cases = Math.max(0, Math.floor(Number(o.quantity_cases ?? o.quantityCases ?? 0) || 0));
  const quantity_boxes = Math.max(0, Math.floor(Number(o.quantity_boxes ?? o.quantityBoxes ?? 0) || 0));

  let status = "unshipped";
  if (o.status != null && String(o.status).trim() !== "") {
    status = String(o.status).trim().toLowerCase();
    if (!COMMITMENT_STATUSES.has(status)) {
      const err = new Error("status must be unshipped, shipped, or cancelled.");
      err.statusCode = 400;
      throw err;
    }
  }

  let sold_at = null;
  if (o.sold_at != null && o.sold_at !== "") {
    sold_at = new Date(o.sold_at).toISOString();
    if (Number.isNaN(Date.parse(sold_at))) {
      sold_at = null;
    }
  } else if (o.soldAt != null && o.soldAt !== "") {
    sold_at = new Date(o.soldAt).toISOString();
    if (Number.isNaN(Date.parse(sold_at))) {
      sold_at = null;
    }
  }

  const notes = o.notes != null ? String(o.notes).trim() || null : null;

  return {
    channel,
    external_order_id,
    product_slug,
    size,
    quantity_cases,
    quantity_boxes,
    status,
    sold_at,
    notes,
  };
}

/**
 * Fields-only normalisation for updates (never reads or applies status).
 * @param {object} raw
 */
function normaliseCommitmentUpdatePayload(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const channelRaw = String(o.channel ?? o.salesChannel ?? "").trim();
  const channel = channelRaw || "amazon_fbm";

  const external_order_id =
    o.external_order_id != null
      ? String(o.external_order_id).trim() || null
      : o.externalOrderId != null
        ? String(o.externalOrderId).trim() || null
        : null;

  const product_slug = String(o.product_slug ?? o.productSlug ?? "").trim();
  const size = String(o.size ?? "").trim();

  const quantity_cases = Math.max(0, Math.floor(Number(o.quantity_cases ?? o.quantityCases ?? 0) || 0));
  const quantity_boxes = Math.max(0, Math.floor(Number(o.quantity_boxes ?? o.quantityBoxes ?? 0) || 0));

  let sold_at = null;
  if (o.sold_at != null && o.sold_at !== "") {
    sold_at = new Date(o.sold_at).toISOString();
    if (Number.isNaN(Date.parse(sold_at))) {
      sold_at = null;
    }
  } else if (o.soldAt != null && o.soldAt !== "") {
    sold_at = new Date(o.soldAt).toISOString();
    if (Number.isNaN(Date.parse(sold_at))) {
      sold_at = null;
    }
  }

  const notes = o.notes != null ? String(o.notes).trim() || null : null;

  if (!product_slug || !size) {
    const err = new Error("product_slug and size are required.");
    err.statusCode = 400;
    throw err;
  }
  if (quantity_cases <= 0 && quantity_boxes <= 0) {
    const err = new Error("At least one of quantity_cases or quantity_boxes must be greater than 0.");
    err.statusCode = 400;
    throw err;
  }

  return {
    channel,
    external_order_id,
    product_slug,
    size,
    quantity_cases,
    quantity_boxes,
    sold_at,
    notes,
  };
}

/**
 * @param {object} input commitment fields (camelCase or snake_case)
 * @param {{ kind?: string, email?: string | null } | null} actor
 */
export async function createSalesChannelCommitment(input, actor) {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."), { statusCode: 503 });
  }

  const row = normaliseCommitmentInput(input);
  if (!row.product_slug || !row.size) {
    const err = new Error("product_slug and size are required.");
    err.statusCode = 400;
    throw err;
  }
  if (row.quantity_cases <= 0 && row.quantity_boxes <= 0) {
    const err = new Error("At least one of quantity_cases or quantity_boxes must be greater than 0.");
    err.statusCode = 400;
    throw err;
  }

  const email = mapActorEmail(actor);
  const now = new Date().toISOString();
  const shippedAt = row.status === "shipped" ? now : null;

  const insert = {
    channel: row.channel,
    external_order_id: row.external_order_id,
    product_slug: row.product_slug,
    size: row.size,
    quantity_cases: row.quantity_cases,
    quantity_boxes: row.quantity_boxes,
    status: row.status,
    sold_at: row.sold_at,
    shipped_at: shippedAt,
    notes: row.notes,
    created_by: email,
    updated_by: email,
    updated_at: now,
  };

  const { data, error } = await client.from("sales_channel_commitments").insert(insert).select("*").single();
  if (error) {
    throw Object.assign(new Error(error.message || "Insert failed."), { statusCode: 500 });
  }
  return data;
}

/**
 * Update commitment line fields only (not status or shipped_at).
 * @param {string} id
 * @param {object} input
 * @param {{ kind?: string, email?: string | null } | null} actor
 */
export async function updateSalesChannelCommitment(id, input, actor) {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."), { statusCode: 503 });
  }

  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("id is required.");
    err.statusCode = 400;
    throw err;
  }

  const fields = normaliseCommitmentUpdatePayload(input);

  const { data: existing, error: fetchErr } = await client.from("sales_channel_commitments").select("id, status").eq("id", sid).maybeSingle();

  if (fetchErr) {
    throw Object.assign(new Error(fetchErr.message || "Lookup failed."), { statusCode: 500 });
  }
  if (!existing) {
    const err = new Error("Commitment not found.");
    err.statusCode = 404;
    throw err;
  }
  if (String(existing.status || "").toLowerCase() !== "unshipped") {
    const err = new Error("Only unshipped commitments can be edited.");
    err.statusCode = 400;
    throw err;
  }

  const email = mapActorEmail(actor);
  const now = new Date().toISOString();

  const patch = {
    channel: fields.channel,
    external_order_id: fields.external_order_id,
    product_slug: fields.product_slug,
    size: fields.size,
    quantity_cases: fields.quantity_cases,
    quantity_boxes: fields.quantity_boxes,
    sold_at: fields.sold_at,
    notes: fields.notes,
    updated_by: email,
    updated_at: now,
  };

  const { data, error } = await client.from("sales_channel_commitments").update(patch).eq("id", sid).select("*").single();

  if (error) {
    throw Object.assign(new Error(error.message || "Update failed."), { statusCode: 500 });
  }
  return data;
}

/**
 * @param {string} id
 * @param {string} status
 * @param {{ kind?: string, email?: string | null } | null} actor
 */
export async function updateSalesChannelCommitmentStatus(id, status, actor) {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."), { statusCode: 503 });
  }

  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("id is required.");
    err.statusCode = 400;
    throw err;
  }

  const st = String(status || "").trim().toLowerCase();
  if (!COMMITMENT_STATUSES.has(st)) {
    const err = new Error("status must be unshipped, shipped, or cancelled.");
    err.statusCode = 400;
    throw err;
  }

  const email = mapActorEmail(actor);
  const now = new Date().toISOString();

  const { data: existing, error: fetchErr } = await client
    .from("sales_channel_commitments")
    .select("id, shipped_at")
    .eq("id", sid)
    .maybeSingle();

  if (fetchErr) {
    throw Object.assign(new Error(fetchErr.message || "Lookup failed."), { statusCode: 500 });
  }
  if (!existing) {
    const err = new Error("Commitment not found.");
    err.statusCode = 404;
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    status: st,
    updated_by: email,
    updated_at: now,
  };

  if (st === "shipped") {
    if (!existing.shipped_at) {
      patch.shipped_at = now;
    }
  }

  const { data, error } = await client.from("sales_channel_commitments").update(patch).eq("id", sid).select("*").single();

  if (error) {
    throw Object.assign(new Error(error.message || "Update failed."), { statusCode: 500 });
  }
  return data;
}

/**
 * @param {string} id
 */
export async function deleteSalesChannelCommitment(id) {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."), { statusCode: 503 });
  }

  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("id is required.");
    err.statusCode = 400;
    throw err;
  }

  const { data, error } = await client.from("sales_channel_commitments").delete().eq("id", sid).select("id");

  if (error) {
    throw Object.assign(new Error(error.message || "Delete failed."), { statusCode: 500 });
  }
  if (!data || data.length === 0) {
    const err = new Error("Commitment not found.");
    err.statusCode = 404;
    throw err;
  }

  return { ok: true };
}
