import { Resend } from "resend";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatOrderDate(iso) {
  try {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(d);
  } catch {
    return "";
  }
}

function formatDateTime(iso) {
  try {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return "";
  }
}

function firstName(order) {
  const raw = String(order?.customer_name || "").trim();
  if (!raw) return "there";
  return raw.split(/\s+/)[0] || "there";
}

function shippedStatusLabel(order) {
  if (String(order?.order_status || "") === "shipped" || order?.admin_handoff_at) {
    const when = formatDateTime(order.admin_handoff_at);
    return when ? `Shipped · ${when}` : "Shipped";
  }
  const ext = String(order?.admin_external_shipped_date || "").trim();
  if (ext) return `Ship date · ${ext}`;
  return "On the way";
}

/**
 * Concise product lines from order.items for the notify email.
 * @param {object} order
 * @returns {Array<{ name: string, size: string, qty: string }>}
 */
export function buildNotifyOrderDetailLines(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const lines = [];
  for (const it of items) {
    const name = String(it?.name || it?.slug || "Product").trim() || "Product";
    const sizeParts = [];
    const qtyObj = it?.quantities && typeof it.quantities === "object" ? it.quantities : null;
    const boxObj = it?.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : null;
    if (qtyObj || boxObj) {
      const keys = new Set([
        ...Object.keys(qtyObj || {}),
        ...Object.keys(boxObj || {}),
      ]);
      for (const sz of keys) {
        const c = Math.floor(Number(qtyObj?.[sz]) || 0);
        const b = Math.floor(Number(boxObj?.[sz]) || 0);
        if (!c && !b) continue;
        const bits = [];
        if (c) bits.push(`${c} case${c === 1 ? "" : "s"}`);
        if (b) bits.push(`${b} box${b === 1 ? "" : "es"}`);
        sizeParts.push(`${sz}: ${bits.join(", ")}`);
      }
    }
    let qty = "";
    if (Array.isArray(it?.bundleLines) && it.bundleLines.length) {
      qty = it.bundleLines
        .map((bl) => {
          const q = Math.floor(Number(bl?.qty) || 0);
          const id = String(bl?.id || "").trim();
          if (!id || q < 1) return "";
          return `${q}× ${id}`;
        })
        .filter(Boolean)
        .join(" · ");
    }
    if (!qty && it?.quantity != null && Number.isFinite(Number(it.quantity))) {
      qty = String(Math.floor(Number(it.quantity)));
    }
    if (!qty && sizeParts.length) qty = "See sizes";
    if (!qty) qty = "—";
    lines.push({
      name,
      size: sizeParts.length ? sizeParts.join(" · ") : "—",
      qty,
    });
  }
  return lines;
}

export function buildBuyerShippingNotifySubject(order) {
  const ref = String(order?.order_ref || "your order").trim() || "your order";
  return `Your SAI Goods order is on the way — ${ref}`;
}

/**
 * @param {object} order
 * @param {{ sourceLabel?: string, carrier?: string, service?: string, trackings?: Array<{ number: string, url?: string, packageLabel?: string, carrier?: string, service?: string }> }} fulfillment
 */
export function buildBuyerShippingNotifyText(order, fulfillment) {
  const ref = String(order?.order_ref || "your order").trim() || "your order";
  const name = firstName(order);
  const trackings = Array.isArray(fulfillment?.trackings) ? fulfillment.trackings : [];
  const lines = [
    `Hi ${name},`,
    "",
    "Shipping information is now available for your order. You can use the tracking details below to follow the package.",
    "",
    `Order: ${ref}`,
    `Status: ${shippedStatusLabel(order)}`,
    fulfillment?.sourceLabel ? `Fulfillment: ${fulfillment.sourceLabel}` : "",
    "",
    "Tracking:",
  ];
  for (const t of trackings) {
    const label = t.packageLabel ? `${t.packageLabel}: ` : "";
    const carrierBits = [t.carrier || fulfillment?.carrier, t.service || fulfillment?.service]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .join(" · ");
    lines.push(`- ${label}${t.number}${carrierBits ? ` (${carrierBits})` : ""}`);
    if (t.url) lines.push(`  Track: ${t.url}`);
  }
  lines.push("", "Thank you for shopping with SAI Goods.");
  lines.push("If you have questions about your order, reply to this email or contact SAI Goods.");
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

function summaryRow(label, value) {
  if (!value) return "";
  return `<tr>
    <td style="padding:7px 12px 7px 0;font-size:14px;color:#a1a1aa;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:7px 0;font-size:14px;font-weight:600;color:#fafafa;text-align:right;vertical-align:top;">${escapeHtml(value)}</td>
  </tr>`;
}

function trackButton(url) {
  const href = String(url || "").trim();
  if (!href) return "";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin-top:12px;padding:12px 18px;background:#BF5841;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Track package</a>`;
}

/**
 * Polished HTML shipping notification (dark card, terracotta accent — SAI Goods brand).
 * @param {object} order
 * @param {{ sourceLabel?: string, carrier?: string, service?: string, trackings?: Array<{ number: string, url?: string, packageLabel?: string, carrier?: string, service?: string }> }} fulfillment
 */
export function buildBuyerShippingNotifyHtml(order, fulfillment) {
  const ref = String(order?.order_ref || "Your order").trim() || "Your order";
  const greet = firstName(order);
  const orderDate = formatOrderDate(order?.created_at || order?.paid_at);
  const sourceLabel = String(fulfillment?.sourceLabel || "").trim() || "—";
  const trackings = Array.isArray(fulfillment?.trackings) ? fulfillment.trackings : [];
  const globalCarrier = [fulfillment?.carrier, fulfillment?.service]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" · ");

  const summaryRows = [
    summaryRow("Order reference", ref),
    summaryRow("Order date", orderDate),
    summaryRow("Status", shippedStatusLabel(order)),
    summaryRow("Fulfillment source", sourceLabel),
  ].join("");

  let trackingCard = "";
  if (trackings.length === 1) {
    const t = trackings[0];
    const carrierLine =
      [t.carrier, t.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ") ||
      globalCarrier ||
      "—";
    const btn = trackButton(t.url);
    trackingCard = `<div style="margin:18px 0 0;padding:18px 16px;background:#2a2a2e;border-radius:10px;border:1px solid #3f3f46;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#a1a1aa;text-transform:uppercase;">Tracking</p>
      <p style="margin:0 0 6px;font-size:13px;color:#a1a1aa;">Carrier / service</p>
      <p style="margin:0 0 14px;font-size:15px;font-weight:600;color:#fafafa;">${escapeHtml(carrierLine)}</p>
      <p style="margin:0 0 6px;font-size:13px;color:#a1a1aa;">Tracking number</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:#fafafa;letter-spacing:0.02em;">${escapeHtml(t.number)}</p>
      ${btn}
    </div>`;
  } else if (trackings.length > 1) {
    const rows = trackings
      .map((t, idx) => {
        const pkg = t.packageLabel || `Package ${idx + 1}`;
        const carrierLine =
          [t.carrier, t.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ") ||
          globalCarrier ||
          "";
        const btn = trackButton(t.url);
        const linkFallback =
          !t.url && t.number
            ? `<p style="margin:8px 0 0;font-size:13px;color:#a1a1aa;">Tracking: ${escapeHtml(t.number)}</p>`
            : "";
        return `<div style="margin:${idx === 0 ? "0" : "14px"} 0 0;padding:${idx === 0 ? "0" : "14px 0 0"};border-top:${idx === 0 ? "none" : "1px solid #3f3f46"};">
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#fafafa;">${escapeHtml(pkg)}</p>
          ${carrierLine ? `<p style="margin:0 0 6px;font-size:13px;color:#a1a1aa;">${escapeHtml(carrierLine)}</p>` : ""}
          <p style="margin:0;font-size:15px;font-weight:600;color:#f4f4f5;letter-spacing:0.02em;">${escapeHtml(t.number)}</p>
          ${btn || linkFallback}
        </div>`;
      })
      .join("");
    trackingCard = `<div style="margin:18px 0 0;padding:18px 16px;background:#2a2a2e;border-radius:10px;border:1px solid #3f3f46;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#a1a1aa;text-transform:uppercase;">Packages</p>
      ${rows}
    </div>`;
  }

  const detailLines = buildNotifyOrderDetailLines(order);
  let detailsCard = "";
  if (detailLines.length) {
    const itemRows = detailLines
      .map(
        (line) => `<tr>
        <td style="padding:10px 8px 10px 0;font-size:14px;color:#fafafa;vertical-align:top;border-top:1px solid #3f3f46;">
          <div style="font-weight:600;">${escapeHtml(line.name)}</div>
          <div style="margin-top:4px;font-size:12px;color:#a1a1aa;">${escapeHtml(line.size)}</div>
        </td>
        <td style="padding:10px 0;font-size:14px;color:#e4e4e7;text-align:right;vertical-align:top;white-space:nowrap;border-top:1px solid #3f3f46;">${escapeHtml(line.qty)}</td>
      </tr>`,
      )
      .join("");
    detailsCard = `<div style="margin:18px 0 0;padding:18px 16px;background:#2a2a2e;border-radius:10px;border:1px solid #3f3f46;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#a1a1aa;text-transform:uppercase;">Order details</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:0 8px 8px 0;font-size:11px;font-weight:700;letter-spacing:0.04em;color:#71717a;text-transform:uppercase;">Product / size</td>
          <td style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.04em;color:#71717a;text-transform:uppercase;text-align:right;">Qty</td>
        </tr>
        ${itemRows}
      </table>
    </div>`;
  }

  const preheader = "Tracking information is now available for your order.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(buildBuyerShippingNotifySubject(order))}</title>
</head>
<body style="margin:0;padding:0;background:#18181b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#18181b;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:640px;background:#1f1f23;border-radius:14px;border:1px solid #3f3f46;padding:32px 26px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.12em;color:#a1a1aa;text-transform:uppercase;">Shipping update</p>
              <h1 style="margin:0 0 18px;font-size:24px;font-weight:700;color:#BF5841;line-height:1.25;">Your order is on the way</h1>

              <p style="margin:0 0 10px;font-size:16px;color:#fafafa;line-height:1.5;">Hi ${escapeHtml(greet)},</p>
              <p style="margin:0 0 22px;font-size:15px;color:#d4d4d8;line-height:1.65;">
                Shipping information is now available for your order. You can use the tracking details below to follow the package.
              </p>

              <div style="margin:0;padding:18px 16px;background:#2a2a2e;border-radius:10px;border:1px solid #3f3f46;">
                <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#a1a1aa;text-transform:uppercase;">Order summary</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  ${summaryRows}
                </table>
              </div>

              ${trackingCard}
              ${detailsCard}

              <p style="margin:28px 0 0;font-size:15px;color:#e4e4e7;line-height:1.55;">
                Thank you for shopping with SAI Goods.
              </p>
              <p style="margin:10px 0 0;font-size:14px;color:#a1a1aa;line-height:1.55;">
                If you have questions about your order, reply to this email or contact SAI Goods.
              </p>
              <p style="margin:20px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
                This email was sent regarding your SAI Goods order ${escapeHtml(ref)}.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Sends a shipping/tracking notification when Resend is configured.
 * @param {object} order — DB order row
 * @param {{ sourceLabel?: string, carrier?: string, service?: string, trackings: Array<{ number: string, url?: string, packageLabel?: string, carrier?: string, service?: string }> }} fulfillment
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendAdminShippingNotifyEmail(order, fulfillment) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(order?.customer_email || "").trim();
  if (!key || !from || !to) {
    return { sent: false, reason: !to ? "missing_customer_email" : "resend_not_configured" };
  }

  const trackings = Array.isArray(fulfillment?.trackings) ? fulfillment.trackings : [];
  if (!trackings.length || !trackings.some((t) => String(t?.number || "").trim())) {
    return { sent: false, reason: "missing_tracking" };
  }

  const html = buildBuyerShippingNotifyHtml(order, fulfillment);
  const text = buildBuyerShippingNotifyText(order, fulfillment);
  const subject = buildBuyerShippingNotifySubject(order);
  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject,
    html,
    text,
  });

  if (error) {
    console.error("[admin] shipping notify email failed", error);
    return { sent: false, reason: "resend_error" };
  }
  return { sent: true };
}
