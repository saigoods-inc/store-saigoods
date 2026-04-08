import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Template lives under data/ so Vercel `includeFiles: "data/**"` bundles it with serverless functions. */
const TEMPLATE_PATH = join(__dirname, "..", "data", "email-templates", "order-confirmation-resend.html");

let cachedTemplate = null;

function loadTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(TEMPLATE_PATH, "utf8");
  }
  return cachedTemplate;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLineItemQty(item) {
  const c = Math.floor(Number(item?.lineCases) || 0);
  const b = Math.floor(Number(item?.lineBoxCount) || 0);
  const parts = [];
  if (c > 0) {
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (b > 0) {
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

function formatOrderDate(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(new Date());
    }
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(d);
  } catch {
    return String(iso || "");
  }
}

function buildItemRowsHtml(items) {
  if (!Array.isArray(items) || !items.length) {
    return `<tr style="margin:0;padding:0"><td data-id="__react-email-column" style="margin:0;padding:0;padding-top:8px;font-size:14px;color:#333"><p style="margin:0;padding:0">—</p></td></tr>`;
  }
  return items
    .map((item, i) => {
      const pt = i === 0 ? "8px" : "10px";
      const name = escapeHtml(item.name || item.slug || "Product");
      const qty = escapeHtml(formatLineItemQty(item));
      return `<tr style="margin:0;padding:0"><td data-id="__react-email-column" style="margin:0;padding:0;padding-top:${pt};font-size:14px;color:#333"><p style="margin:0;padding:0">${name}<br />${qty}</p></td></tr>`;
    })
    .join("");
}

export function buildOrderConfirmationHtml({ pending, quote, customerName }) {
  const greet = (customerName || "").trim() || "there";
  const orderId = pending?.order_ref || String(pending?.id ?? "");
  const orderDate = formatOrderDate(pending?.created_at);
  const total = quote?.totalFormatted ?? "—";
  const items = quote?.items ?? [];

  return loadTemplate()
    .replace(/%%CUSTOMER_NAME%%/g, escapeHtml(greet))
    .replace(/%%ORDER_ID%%/g, escapeHtml(orderId))
    .replace(/%%ORDER_DATE%%/g, escapeHtml(orderDate))
    .replace(/%%ORDER_TOTAL%%/g, escapeHtml(total))
    .replace(/%%ITEM_ROWS%%/g, buildItemRowsHtml(items));
}

/**
 * Sends the branded order confirmation via Resend (non-blocking callers should .catch).
 * Requires RESEND_API_KEY and RESEND_FROM (verified domain in Resend).
 */
export async function sendResendOrderConfirmation({ pending, quote, customerEmail, customerName }) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!key || !from || !customerEmail?.trim()) {
    return;
  }

  const html = buildOrderConfirmationHtml({ pending, quote, customerName });
  const resend = new Resend(key);
  const subjectLabel = pending?.order_ref || "SAI Goods";

  const { error } = await resend.emails.send({
    from,
    to: [customerEmail.trim()],
    subject: `Order confirmed — ${subjectLabel}`,
    html,
  });

  if (error) {
    console.error("Resend order confirmation failed:", error);
  }
}

/** True when customer confirmation is handled by Resend (webhook should not SendGrid duplicate). */
export function isResendCustomerEmailEnabled() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());
}
