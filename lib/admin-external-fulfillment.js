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

/** @param {string | null | undefined} col */
export function storagePathLinesFromColumn(col) {
  return String(col || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hasExternalShippingLabel(row) {
  return storagePathLinesFromColumn(row?.admin_external_label_storage_path).length > 0;
}

/** One or more tracking numbers (newline-separated in DB). */
export function externalTrackingLinesFromRow(row) {
  const s = String(row?.admin_external_tracking_number || "").trim();
  if (!s) {
    return [];
  }
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function manualFulfillmentRecordComplete(row) {
  return (
    Boolean(String(row?.admin_external_carrier || "").trim()) &&
    externalTrackingLinesFromRow(row).length > 0 &&
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

const DEFAULT_MAX_FILES_PER_SAVE = 25;

/**
 * @param {string} orderId
 * @param {{ carrier: string, service?: string, labelCostCents?: number|null, trackingNumber: string, shippedDate?: string|null }} fields
 * @param {{ labels?: { buffer: Buffer, filename: string }[], packingSlips?: { buffer: Buffer, filename: string }[] }} files
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
  const rawTracking = String(fields.trackingNumber || "").trim();
  const trackingLines = rawTracking
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!carrier) {
    const e = new Error("Carrier / agent is required.");
    e.statusCode = 400;
    throw e;
  }
  if (!trackingLines.length) {
    const e = new Error("Enter at least one tracking number (one per line for multiple labels).");
    e.statusCode = 400;
    throw e;
  }
  const trackingNormalized = trackingLines.join("\n");

  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const bucket = docsBucket();
  const now = orderRowNowIso();

  const maxPerSave = Math.min(
    50,
    Math.max(1, Number(process.env.ADMIN_FULFILLMENT_MAX_FILES_PER_SAVE) || DEFAULT_MAX_FILES_PER_SAVE),
  );

  const labelSpecs = Array.isArray(files.labels)
    ? files.labels
    : files.label && files.label.buffer && files.label.buffer.length
      ? [files.label]
      : [];
  const slipSpecs = Array.isArray(files.packingSlips)
    ? files.packingSlips
    : files.packingSlip && files.packingSlip.buffer && files.packingSlip.buffer.length
      ? [files.packingSlip]
      : [];

  if (labelSpecs.length > maxPerSave || slipSpecs.length > maxPerSave) {
    const e = new Error(`At most ${maxPerSave} new files per type per save.`);
    e.statusCode = 400;
    throw e;
  }

  let labelPaths = storagePathLinesFromColumn(existing.admin_external_label_storage_path);
  let packingPaths = storagePathLinesFromColumn(existing.admin_external_packing_slip_storage_path);

  const uploadOne = async (kind, spec) => {
    if (!spec || !spec.buffer || !spec.buffer.length) {
      return null;
    }
    const fn = sanitizeFilename(spec.filename);
    const objectPath = `orders/${idFilter}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${fn}`;
    const { error: upErr } = await client.storage.from(bucket).upload(objectPath, spec.buffer, {
      contentType: guessContentType(fn),
      upsert: true,
    });
    if (upErr) {
      const e = new Error(upErr.message || `Upload failed (${kind}).`);
      e.statusCode = 502;
      throw e;
    }
    return objectPath;
  };

  for (const spec of labelSpecs) {
    const p = await uploadOne("label", spec);
    if (p) {
      labelPaths.push(p);
    }
  }
  for (const spec of slipSpecs) {
    const p = await uploadOne("packing-slip", spec);
    if (p) {
      packingPaths.push(p);
    }
  }

  labelPaths = [...new Set(labelPaths)];
  packingPaths = [...new Set(packingPaths)];

  const labelPath = labelPaths.length ? labelPaths.join("\n") : null;
  const packingPath = packingPaths.length ? packingPaths.join("\n") : null;

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
    admin_external_tracking_number: trackingNormalized,
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
  const rawTrack = String(body?.trackingNumbers ?? body?.trackingNumber ?? "").trim();
  const trackingLines = rawTrack
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const trackingNumber = trackingLines.join("\n");
  const shippedDate = String(body?.shippedDate || "").trim();
  const labelCostRaw = body?.labelCostCents;
  let labelCostCents = null;
  if (labelCostRaw != null && labelCostRaw !== "") {
    const n = Math.round(Number(labelCostRaw));
    if (Number.isFinite(n) && n >= 0) {
      labelCostCents = n;
    }
  }

  const labels = [];
  if (Array.isArray(body?.labelFiles) && body.labelFiles.length) {
    body.labelFiles.forEach((item, i) => {
      const buf = decodeBase64FileField(item?.base64 ?? item?.data, `Shipping label file ${i + 1}`);
      if (buf && buf.length) {
        labels.push({
          buffer: buf,
          filename: String(item?.name || item?.filename || `label-${i + 1}.pdf`),
        });
      }
    });
  } else {
    const labelBuf = decodeBase64FileField(body?.labelFileBase64, "Shipping label file");
    if (labelBuf && labelBuf.length) {
      labels.push({ buffer: labelBuf, filename: String(body?.labelFileName || "label.pdf") });
    }
  }

  const packingSlips = [];
  if (Array.isArray(body?.packingSlipFiles) && body.packingSlipFiles.length) {
    body.packingSlipFiles.forEach((item, i) => {
      const buf = decodeBase64FileField(item?.base64 ?? item?.data, `Packing slip file ${i + 1}`);
      if (buf && buf.length) {
        packingSlips.push({
          buffer: buf,
          filename: String(item?.name || item?.filename || `packing-slip-${i + 1}.pdf`),
        });
      }
    });
  } else {
    const packingBuf = decodeBase64FileField(body?.packingSlipFileBase64, "Packing slip file");
    if (packingBuf && packingBuf.length) {
      packingSlips.push({ buffer: packingBuf, filename: String(body?.packingSlipFileName || "packing-slip.pdf") });
    }
  }

  return {
    fields: { carrier, service, labelCostCents, trackingNumber, shippedDate },
    files: { labels, packingSlips },
  };
}

export async function createSignedFulfillmentDocUrls(orderId, kind) {
  const existing = await getOrderById(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  const raw =
    kind === "packing_slip"
      ? existing.admin_external_packing_slip_storage_path
      : existing.admin_external_label_storage_path;
  const paths = storagePathLinesFromColumn(raw);
  if (!paths.length) {
    const e = new Error("No file on record for this document type.");
    e.statusCode = 404;
    throw e;
  }
  const client = getClient();
  const bucket = docsBucket();
  const ttl = Math.min(Math.max(Number(process.env.ADMIN_FULFILLMENT_DOC_URL_TTL_SEC) || 3600, 60), 60 * 60 * 24);
  const urls = [];
  for (const path of paths) {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttl);
    if (error || !data?.signedUrl) {
      const e = new Error(error?.message || "Could not create download URL.");
      e.statusCode = 502;
      throw e;
    }
    urls.push(data.signedUrl);
  }
  return { urls, expiresIn: ttl };
}

/** @returns {{ url: string, expiresIn: number }} First document (compat). */
export async function createSignedFulfillmentDocUrl(orderId, kind) {
  const { urls, expiresIn } = await createSignedFulfillmentDocUrls(orderId, kind);
  if (!urls.length) {
    const e = new Error("No file on record for this document type.");
    e.statusCode = 404;
    throw e;
  }
  return { url: urls[0], expiresIn };
}
