import { createClient } from "@supabase/supabase-js";

let cachedClient = null;

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase credentials are not configured.");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

function coerceOrderIdForQuery(orderId) {
  if (orderId == null || orderId === "") {
    return orderId;
  }
  const s = String(orderId).trim();
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  return s;
}

function orderRowNowIso() {
  return new Date().toISOString();
}

function docsBucket() {
  return String(process.env.SUPABASE_ORDER_DOCS_BUCKET || "order-fulfillment-docs").trim() || "order-fulfillment-docs";
}

function sanitizeFilename(name) {
  const base = String(name || "document")
    .replace(/[/\\]/g, "-")
    .replace(/[^\w.\-()+ ]/g, "_")
    .slice(0, 120);
  return base || "document";
}

function guessContentType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function decodeBase64FileField(raw, label) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) {
    return null;
  }
  let buf;
  try {
    buf = Buffer.from(s, "base64");
  } catch {
    const e = new Error(`${label} is not valid base64.`);
    e.statusCode = 400;
    throw e;
  }
  const maxBytes = Math.max(1, Number(process.env.ADMIN_FULFILLMENT_UPLOAD_MAX_BYTES) || 12_000_000);
  if (buf.length > maxBytes) {
    const e = new Error(`${label} exceeds maximum upload size.`);
    e.statusCode = 413;
    throw e;
  }
  if (buf.length === 0) {
    return null;
  }
  return buf;
}

export function hasExternalShippingLabel(row) {
  return Boolean(String(row?.admin_external_label_storage_path || "").trim());
}

export function manualFulfillmentRecordComplete(row) {
  return (
    Boolean(String(row?.admin_external_carrier || "").trim()) &&
    Boolean(String(row?.admin_external_tracking_number || "").trim()) &&
    hasExternalShippingLabel(row)
  );
}

async function getOrderById(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client.from("orders").select("*").eq("id", idFilter).maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * @param {string} orderId
 * @param {{ carrier: string, service?: string, labelCostCents?: number|null, trackingNumber: string, shippedDate?: string|null }} fields
 * @param {{ label?: { buffer: Buffer, filename: string }, packingSlip?: { buffer: Buffer, filename: string } }} files
 */
export async function saveAdminExternalFulfillmentRecord(orderId, fields, files = {}) {
  if (orderId == null || orderId === "") {
    const e = new Error("orderId is required.");
    e.statusCode = 400;
    throw e;
  }
  const existing = await getOrderById(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.status || "").toLowerCase() !== "paid") {
    const e = new Error("Only paid orders can save fulfillment records.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") === "shipped" || existing.admin_handoff_at) {
    const e = new Error("This order is already marked shipped.");
    e.statusCode = 400;
    throw e;
  }

  const carrier = String(fields.carrier || "").trim();
  const trackingNumber = String(fields.trackingNumber || "").trim();
  if (!carrier) {
    const e = new Error("Carrier / agent is required.");
    e.statusCode = 400;
    throw e;
  }

  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const bucket = docsBucket();
  const now = orderRowNowIso();

  let labelPath = String(existing.admin_external_label_storage_path || "").trim() || null;
  let packingPath = String(existing.admin_external_packing_slip_storage_path || "").trim() || null;

  const uploadOne = async (kind, spec) => {
    if (!spec || !spec.buffer || !spec.buffer.length) {
      return;
    }
    const fn = sanitizeFilename(spec.filename);
    const objectPath = `orders/${idFilter}/${kind}-${Date.now()}-${fn}`;
    const { error: upErr } = await client.storage.from(bucket).upload(objectPath, spec.buffer, {
      contentType: guessContentType(fn),
      upsert: true,
    });
    if (upErr) {
      const e = new Error(upErr.message || `Upload failed (${kind}).`);
      e.statusCode = 502;
      throw e;
    }
    if (kind === "label") {
      labelPath = objectPath;
    } else {
      packingPath = objectPath;
    }
  };

  await uploadOne("label", files.label);
  await uploadOne("packing-slip", files.packingSlip);

  const service = String(fields.service || "").trim() || null;
  const shippedDateRaw = String(fields.shippedDate || "").trim();
  const shippedDate = /^\d{4}-\d{2}-\d{2}$/.test(shippedDateRaw) ? shippedDateRaw : null;

  let labelCostCents = null;
  if (fields.labelCostCents != null && fields.labelCostCents !== "") {
    const n = Math.round(Number(fields.labelCostCents));
    if (Number.isFinite(n) && n >= 0) {
      labelCostCents = n;
    }
  }

  const updates = {
    admin_external_carrier: carrier,
    admin_external_service: service || null,
    admin_external_label_cost_cents: labelCostCents,
    admin_external_tracking_number: trackingNumber || null,
    admin_external_shipped_date: shippedDate,
    admin_external_fulfillment_saved_at: now,
    updated_at: now,
  };
  if (labelPath) {
    updates.admin_external_label_storage_path = labelPath;
  }
  if (packingPath) {
    updates.admin_external_packing_slip_storage_path = packingPath;
  }

  const { data, error } = await client.from("orders").update(updates).eq("id", idFilter).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export function parseExternalFulfillmentBody(body) {
  const carrier = String(body?.carrier || "").trim();
  const service = String(body?.service || "").trim();
  const trackingNumber = String(body?.trackingNumber || "").trim();
  const shippedDate = String(body?.shippedDate || "").trim();
  const labelCostRaw = body?.labelCostCents;
  let labelCostCents = null;
  if (labelCostRaw != null && labelCostRaw !== "") {
    const n = Math.round(Number(labelCostRaw));
    if (Number.isFinite(n) && n >= 0) {
      labelCostCents = n;
    }
  }

  const labelBuf = decodeBase64FileField(body?.labelFileBase64, "Shipping label file");
  const packingBuf = decodeBase64FileField(body?.packingSlipFileBase64, "Packing slip file");

  const files = {};
  if (labelBuf) {
    files.label = { buffer: labelBuf, filename: String(body?.labelFileName || "label.pdf") };
  }
  if (packingBuf) {
    files.packingSlip = { buffer: packingBuf, filename: String(body?.packingSlipFileName || "packing-slip.pdf") };
  }

  return {
    fields: { carrier, service, labelCostCents, trackingNumber, shippedDate },
    files,
  };
}

export async function createSignedFulfillmentDocUrl(orderId, kind) {
  const existing = await getOrderById(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  const path =
    kind === "packing_slip"
      ? String(existing.admin_external_packing_slip_storage_path || "").trim()
      : String(existing.admin_external_label_storage_path || "").trim();
  if (!path) {
    const e = new Error("No file on record for this document type.");
    e.statusCode = 404;
    throw e;
  }
  const client = getClient();
  const bucket = docsBucket();
  const ttl = Math.min(Math.max(Number(process.env.ADMIN_FULFILLMENT_DOC_URL_TTL_SEC) || 3600, 60), 60 * 60 * 24);
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    const e = new Error(error?.message || "Could not create download URL.");
    e.statusCode = 502;
    throw e;
  }
  return { url: data.signedUrl, expiresIn: ttl };
}
