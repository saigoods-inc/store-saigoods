import crypto from "node:crypto";

import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

export const MAX_TAX_EXEMPTION_CERTIFICATE_BYTES = 2 * 1024 * 1024;

const ALLOWED_EXEMPTION_TYPES = new Set([
  "organization_own_use",
  "government",
  "resale",
  "other",
]);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeState(value) {
  const state = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(state) ? state : "";
}

function normalizeDate(value, label) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw badRequest(`${label} must be a valid date.`);
  }
  return text;
}

function normalizeText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function money(cents) {
  return `$${(Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2)}`;
}

function certificateBucket() {
  return String(
    process.env.TAX_EXEMPTION_DOCS_BUCKET ||
      process.env.SUPABASE_ORDER_DOCS_BUCKET ||
      "order-fulfillment-docs",
  ).trim() || "order-fulfillment-docs";
}

function referenceSecret() {
  return String(
    process.env.TAX_EXEMPTION_REFERENCE_SECRET ||
      process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET ||
      process.env.CHECKOUT_QUOTE_SIGNING_SECRET ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "",
  ).trim();
}

function certificateReferenceSignature(encoded) {
  return crypto.createHmac("sha256", referenceSecret()).update(encoded).digest("base64url");
}

function sanitizeFilename(name) {
  const clean = String(name || "certificate")
    .replace(/[\r\n]/g, " ")
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._ ()+-]/g, "_")
    .trim()
    .slice(0, 120);
  return clean || "certificate";
}

function contentTypeFromMagic(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return null;
}

async function assertBucketIsPrivate(client, bucket) {
  const { data, error } = await client.storage.getBucket(bucket);
  if (error) {
    const next = new Error("The private tax-certificate storage is not available.");
    next.statusCode = 503;
    throw next;
  }
  if (data?.public === true) {
    const next = new Error("Tax certificates cannot be stored because the configured document bucket is public.");
    next.statusCode = 503;
    throw next;
  }
}

export function parseTaxExemptionDetails(raw, { shippingAddress, customer } = {}) {
  if (!raw || raw.requested !== true) return null;
  const exemptionType = String(raw.exemptionType || "").trim().toLowerCase();
  if (!ALLOWED_EXEMPTION_TYPES.has(exemptionType)) {
    throw badRequest("Select a supported tax exemption type.");
  }
  const jurisdiction = normalizeState(raw.jurisdiction);
  const shippingState = normalizeState(shippingAddress?.state);
  if (!jurisdiction) throw badRequest("Select the exemption jurisdiction.");
  if (!shippingState || jurisdiction !== shippingState) {
    throw badRequest("The exemption jurisdiction must match the current shipping state.");
  }
  if (raw.documentReviewed !== true) {
    throw badRequest("Confirm that an administrator reviewed the exemption certificate.");
  }
  if (raw.certificateSelected !== true) {
    throw badRequest("Upload the buyer's exemption certificate before removing tax.");
  }
  const effectiveDate = normalizeDate(raw.effectiveDate, "Effective date");
  const expirationDate = normalizeDate(raw.expirationDate, "Expiration date");
  if (effectiveDate && expirationDate && expirationDate < effectiveDate) {
    throw badRequest("Expiration date cannot be before the effective date.");
  }
  const internalNote = normalizeText(raw.internalNote, 1000);
  if (exemptionType === "other" && (!internalNote || internalNote.length < 10)) {
    throw badRequest("Add an internal review note for an unusual exemption.");
  }
  const customerName = normalizeText(customer?.name, 200);
  if (!customerName) throw badRequest("Customer name is required for a tax exemption.");

  return {
    status: "preview",
    exemptionType,
    jurisdiction,
    certificateNumber: normalizeText(raw.certificateNumber, 120),
    effectiveDate,
    expirationDate,
    internalNote,
    customerName,
    documentReviewed: true,
  };
}

export function parseTaxExemptionCertificate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw badRequest("Upload the buyer's exemption certificate before removing tax.");
  }
  const filename = sanitizeFilename(input.filename);
  const declaredContentType = String(input.contentType || "").trim().toLowerCase();
  const contentBase64 = String(input.contentBase64 || "").trim();
  const declaredSize = Number(input.sizeBytes);
  if (!contentBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw badRequest("The exemption certificate could not be read. Select the file again.");
  }
  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length || buffer.length > MAX_TAX_EXEMPTION_CERTIFICATE_BYTES || declaredSize !== buffer.length) {
    throw badRequest("The exemption certificate must be 2 MB or smaller.");
  }
  const detectedContentType = contentTypeFromMagic(buffer);
  if (!detectedContentType || detectedContentType !== declaredContentType) {
    throw badRequest("The exemption certificate must be a valid PDF, PNG, JPG, or JPEG file.");
  }
  const extensionOk =
    (detectedContentType === "application/pdf" && /\.pdf$/i.test(filename)) ||
    (detectedContentType === "image/png" && /\.png$/i.test(filename)) ||
    (detectedContentType === "image/jpeg" && /\.(jpg|jpeg)$/i.test(filename));
  if (!extensionOk) throw badRequest("The exemption certificate filename does not match its file type.");
  return {
    buffer,
    filename,
    contentType: detectedContentType,
    sizeBytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

export function applyTaxExemptionToQuote(quote, exemption) {
  if (!exemption) return quote;
  const taxExcludedCents = Math.max(0, Math.round(Number(quote?.taxCents) || 0));
  const subtotalCents = Math.max(0, Math.round(Number(quote?.subtotalCents) || 0));
  const shippingCents = Math.max(0, Math.round(Number(quote?.shippingCents) || 0));
  const totalCents = subtotalCents + shippingCents;
  return {
    ...quote,
    tax: {
      ...(quote?.tax || {}),
      taxCents: 0,
      amountCents: 0,
      amountFormatted: money(0),
      exempt: true,
      taxExcludedCents,
    },
    totals: {
      ...(quote?.totals || {}),
      subtotalCents,
      shippingCents,
      taxCents: 0,
      totalCents,
      totalFormatted: money(totalCents),
    },
    taxCents: 0,
    taxFormatted: money(0),
    totalCents,
    totalFormatted: money(totalCents),
    taxExemption: { ...exemption, taxExcludedCents },
  };
}

export async function uploadTaxExemptionCertificate(certificate) {
  const client = getSupabaseServiceRoleClient();
  const bucket = certificateBucket();
  await assertBucketIsPrivate(client, bucket);
  const objectPath = `tax-exempt/${crypto.randomUUID()}/${certificate.filename}`;
  const { error } = await client.storage.from(bucket).upload(objectPath, certificate.buffer, {
    contentType: certificate.contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (error) {
    const next = new Error(error.message || "The exemption certificate could not be stored.");
    next.statusCode = 502;
    throw next;
  }
  return {
    storagePath: objectPath,
    filename: certificate.filename,
    contentType: certificate.contentType,
    sizeBytes: certificate.sizeBytes,
    sha256: certificate.sha256,
  };
}

export async function deleteTaxExemptionCertificate(storagePath) {
  const path = String(storagePath || "").trim();
  if (!path) return;
  const client = getSupabaseServiceRoleClient();
  await client.storage.from(certificateBucket()).remove([path]);
}

export function approvedTaxExemptionSnapshot({ details, certificate, actor, customer, shippingAddress }) {
  const approvedAt = new Date().toISOString();
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    name: String(customer?.name || "").trim().toLowerCase(),
    email: String(customer?.email || "").trim().toLowerCase(),
    address: {
      line1: String(shippingAddress?.line1 || "").trim().toUpperCase(),
      line2: String(shippingAddress?.line2 || "").trim().toUpperCase(),
      city: String(shippingAddress?.city || "").trim().toUpperCase(),
      state: normalizeState(shippingAddress?.state),
      postalCode: String(shippingAddress?.postalCode || "").trim().toUpperCase(),
      country: String(shippingAddress?.country || "US").trim().toUpperCase(),
    },
  })).digest("hex");
  return {
    ...details,
    status: "approved",
    approvedAt,
    approvedBy: actor?.email || actor?.id || (actor?.kind === "service" ? "internal-service" : "authorized-admin"),
    approvalFingerprint: fingerprint,
    certificate,
  };
}

export function taxExemptionFromOrder(order) {
  const raw = order?.checkout_quote_snapshot_json;
  let snapshot = raw;
  if (typeof raw === "string") {
    try { snapshot = JSON.parse(raw); } catch { snapshot = null; }
  }
  const exemption = snapshot?.taxExemption;
  return exemption && typeof exemption === "object" && exemption.status === "approved" ? exemption : null;
}

export function issueTaxExemptionCertificateReference(exemption) {
  const secret = referenceSecret();
  const certificate = exemption?.certificate;
  if (!secret || !certificate?.storagePath) return null;
  const payload = {
    v: 1,
    exp: Date.now() + 30 * 60 * 1000,
    storagePath: certificate.storagePath,
    filename: certificate.filename,
    contentType: certificate.contentType,
    sizeBytes: certificate.sizeBytes,
    sha256: certificate.sha256,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${certificateReferenceSignature(encoded)}`;
}

export function verifyTaxExemptionCertificateReference(reference, existingExemption) {
  const secret = referenceSecret();
  const [encoded, supplied, extra] = String(reference || "").split(".");
  if (!secret || !encoded || !supplied || extra) throw badRequest("The saved exemption certificate reference is invalid.");
  const expected = certificateReferenceSignature(encoded);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw badRequest("The saved exemption certificate reference is invalid.");
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { payload = null; }
  if (payload?.v !== 1 || Date.now() > Number(payload?.exp) || !payload?.storagePath) {
    throw badRequest("The saved exemption certificate reference expired. Reload the order and try again.");
  }
  if (!existingExemption?.certificate?.storagePath || payload.storagePath !== existingExemption.certificate.storagePath) {
    throw badRequest("The saved exemption certificate does not belong to this order.");
  }
  return {
    storagePath: payload.storagePath,
    filename: payload.filename,
    contentType: payload.contentType,
    sizeBytes: payload.sizeBytes,
    sha256: payload.sha256,
  };
}

export async function createSignedTaxExemptionCertificateUrl(exemption) {
  const path = String(exemption?.certificate?.storagePath || "").trim();
  if (!path) throw badRequest("No exemption certificate is stored for this order.");
  const client = getSupabaseServiceRoleClient();
  const bucket = certificateBucket();
  await assertBucketIsPrivate(client, bucket);
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 300, {
    download: exemption.certificate.filename || "tax-exemption-certificate",
  });
  if (error || !data?.signedUrl) {
    const next = new Error("The exemption certificate could not be opened.");
    next.statusCode = 502;
    throw next;
  }
  return data.signedUrl;
}
