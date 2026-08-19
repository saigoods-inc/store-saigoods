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

function formatBundleLabel(id) {
  const raw = String(id || "").trim();
  const match = raw.match(/^(box|case)_(\d+)$/i);
  if (!match) return raw;
  const count = Math.max(1, Math.floor(Number(match[2]) || 1));
  const kind = match[1].toLowerCase();
  return `${count} ${kind}${count === 1 ? "" : "es"}`;
}

function prettySize(size) {
  const raw = String(size || "").trim();
  return { S: "Small", M: "Medium", L: "Large", XL: "X Large" }[raw] || raw;
}

function shippedStatusLabel(order) {
  if (String(order?.order_status || "") === "shipped" || order?.admin_handoff_at) {
    const when = formatDateTime(order.admin_handoff_at);
    return when ? `Shipped · ${when}` : "Shipped";
  }
  const ext = String(order?.admin_external_shipped_date || "").trim();
  if (ext) return `Ship date · ${ext}`;
  return "Shipped";
}

/**
 * Concise product lines from order.items for the notify email.
 * @param {object} order
 * @returns {Array<{ name: string, detail: string }>}
 */
export function buildNotifyOrderDetailLines(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const lines = [];
  for (const it of items) {
    const name = String(it?.name || it?.slug || "Product").trim() || "Product";
    const allocationParts = [];
    const displaySizes = [];
    const qtyObj = it?.quantities && typeof it.quantities === "object" ? it.quantities : null;
    const boxObj = it?.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : null;
    if (qtyObj || boxObj) {
      const keys = new Set([...Object.keys(qtyObj || {}), ...Object.keys(boxObj || {})]);
      for (const sz of keys) {
        const c = Math.floor(Number(qtyObj?.[sz]) || 0);
        const b = Math.floor(Number(boxObj?.[sz]) || 0);
        if (!c && !b) continue;
        const bits = [];
        if (c) bits.push(`${c} case${c === 1 ? "" : "s"}`);
        if (b) bits.push(`${b} box${b === 1 ? "" : "es"}`);
        const size = prettySize(sz);
        displaySizes.push(size);
        allocationParts.push(`${size}: ${bits.join(", ")}`);
      }
    }
    let detail = "";
    if (Array.isArray(it?.bundleLines) && it.bundleLines.length) {
      const bundle = it.bundleLines
        .map((bl) => {
          const q = Math.floor(Number(bl?.qty) || 0);
          const label = formatBundleLabel(bl?.id);
          if (!label || q < 1) return "";
          return q === 1 ? label : `${q}x ${label}`;
        })
        .filter(Boolean)
        .join(", ");
      const sizeText = displaySizes.length ? displaySizes.join(", ") : allocationParts.join(", ");
      const quantity = Math.floor(Number(it?.quantity) || 0) || 1;
      detail = [
        bundle ? `Bundle: ${bundle}` : "",
        sizeText ? `Size: ${sizeText}` : "",
        `Quantity: ${quantity}x`,
      ].filter(Boolean).join(" - ");
    }
    if (!detail) {
      const quantity =
        it?.quantity != null && Number.isFinite(Number(it.quantity))
          ? String(Math.floor(Number(it.quantity)))
          : "";
      detail = [allocationParts.join(" - "), quantity ? `Quantity: ${quantity}x` : ""].filter(Boolean).join(" - ");
    }
    if (!detail) detail = "-";
    lines.push({
      name,
      detail,
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
    "Your order is on the way.",
    "",
    `Order: ${ref}`,
    `Status: ${shippedStatusLabel(order)}`,
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
  lines.push("Questions about this shipment? Email sales@saigoods.com and we will help.");
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

function trackButton(url) {
  const href = String(url || "").trim();
  if (!href) return "";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin-top:14px;border-radius:999px;background:#cf5849;color:#ffffff;font-size:14px;line-height:20px;font-weight:800;text-decoration:none;padding:9px 18px;">Track package</a>`;
}

function trackingCardHtml(fulfillment) {
  const trackings = Array.isArray(fulfillment?.trackings) ? fulfillment.trackings : [];
  if (!trackings.length) return "";
  if (trackings.length === 1) {
    const t = trackings[0];
    const carrierLine =
      [t.carrier, t.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ") ||
      [fulfillment?.carrier, fulfillment?.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
    return `<div style="margin-top:20px;border:1px solid #eadfd8;border-radius:8px;padding:16px;background:#fbf8f6;">
  <div style="font-size:12px;line-height:16px;font-weight:700;color:#8b817b;text-transform:uppercase;">Tracking</div>
  ${carrierLine ? `<div style="margin-top:8px;font-size:13px;line-height:18px;color:#5f5650;">${escapeHtml(carrierLine)}</div>` : ""}
  <div style="margin-top:6px;font-size:18px;line-height:24px;font-weight:800;color:#2b2927;word-break:break-word;">${escapeHtml(t.number)}</div>
  ${trackButton(t.url)}
</div>`;
  }

  const rows = trackings
    .map((t, index) => {
      const carrierLine =
        [t.carrier, t.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ") ||
        [fulfillment?.carrier, fulfillment?.service].map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
      return `<div style="padding:${index === 0 ? "0" : "14px 0 0"};margin:${index === 0 ? "0" : "14px 0 0"};border-top:${index === 0 ? "0" : "1px solid #eadfd8"};">
  <div style="font-size:13px;line-height:18px;font-weight:800;color:#2b2927;">${escapeHtml(t.packageLabel || `Package ${index + 1}`)}</div>
  ${carrierLine ? `<div style="margin-top:4px;font-size:12px;line-height:17px;color:#8b817b;">${escapeHtml(carrierLine)}</div>` : ""}
  <div style="margin-top:5px;font-size:15px;line-height:21px;font-weight:800;color:#2b2927;word-break:break-word;">${escapeHtml(t.number)}</div>
  ${trackButton(t.url)}
</div>`;
    })
    .join("");
  return `<div style="margin-top:20px;border:1px solid #eadfd8;border-radius:8px;padding:16px;background:#fbf8f6;">
  <div style="font-size:12px;line-height:16px;font-weight:700;color:#8b817b;text-transform:uppercase;">Packages</div>
  <div style="margin-top:10px;">${rows}</div>
</div>`;
}

/**
 * Polished HTML shipping notification.
 * @param {object} order
 * @param {{ sourceLabel?: string, carrier?: string, service?: string, trackings?: Array<{ number: string, url?: string, packageLabel?: string, carrier?: string, service?: string }> }} fulfillment
 */
export function buildBuyerShippingNotifyHtml(order, fulfillment = {}) {
  const ref = String(order?.order_ref || "Your order").trim() || "Your order";
  const greet = firstName(order);
  const orderDate = formatOrderDate(order?.created_at || order?.paid_at);
  const trackingCard = trackingCardHtml(fulfillment);
  const preheader = "Tracking information is now available for your order.";
  const detailLines = buildNotifyOrderDetailLines(order);
  const detailsBlock = detailLines.length
    ? `<div style="margin-top:20px;border:1px solid #eadfd8;border-radius:8px;padding:16px;background:#ffffff;">
  <div style="font-size:12px;line-height:16px;font-weight:700;color:#8b817b;text-transform:uppercase;">Order details</div>
  ${detailLines.map((line) => `<div style="margin-top:12px;border-top:1px solid #eadfd8;padding-top:12px;">
    <div style="font-size:14px;line-height:20px;font-weight:800;color:#2b2927;">${escapeHtml(line.name)}</div>
    <div style="margin-top:3px;font-size:12px;line-height:17px;color:#8b817b;">${escapeHtml(line.detail)}</div>
  </div>`).join("")}
</div>`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f6f1ed;color:#2b2927;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <div style="padding:28px 14px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #eadfd8;border-radius:18px;overflow:hidden;">
      <div style="padding:22px 22px 16px;border-bottom:1px solid #eadfd8;background:#fffaf7;">
        <div style="font-size:13px;line-height:18px;font-weight:800;color:#cf5849;letter-spacing:0;">SAI Goods, Inc.</div>
        <h1 style="margin:12px 0 0;font-size:28px;line-height:34px;font-weight:800;color:#2b2927;">Your order is on the way</h1>
      </div>
      <div style="padding:22px;">
        <p style="margin:0;font-size:16px;line-height:24px;color:#5f5650;">Hi ${escapeHtml(greet)},</p>
        <p style="margin:14px 0 0;font-size:16px;line-height:25px;color:#5f5650;">
          Your order is on the way. Use the tracking details below to follow the package.
        </p>
        <div style="margin-top:20px;border:1px solid #eadfd8;border-radius:8px;padding:16px;background:#ffffff;">
          <div style="font-size:12px;line-height:16px;font-weight:700;color:#8b817b;text-transform:uppercase;">Order summary</div>
          <div style="margin-top:12px;font-size:14px;line-height:20px;color:#5f5650;">Order reference</div>
          <div style="font-size:17px;line-height:24px;font-weight:800;color:#2b2927;word-break:break-word;">${escapeHtml(ref)}</div>
          ${orderDate ? `<div style="margin-top:10px;font-size:14px;line-height:20px;color:#5f5650;">Order date</div><div style="font-size:15px;line-height:22px;font-weight:700;color:#2b2927;">${escapeHtml(orderDate)}</div>` : ""}
        </div>
        ${detailsBlock}
        ${trackingCard}
        <div style="margin-top:22px;border-top:1px solid #eadfd8;padding-top:18px;">
          <p style="margin:0;font-size:15px;line-height:23px;font-weight:600;color:#5f5650;">Thank you for shopping with SAI Goods.</p>
          <p style="margin:8px 0 0;font-size:12px;line-height:18px;color:#8b817b;">Questions about this shipment? Email <a href="mailto:sales@saigoods.com" style="color:#cf5849;text-decoration:none;font-weight:700;">sales@saigoods.com</a> and we will help.</p>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Sends a shipping/tracking notification when Resend is configured.
 * @param {object} order — DB order row
 * @param {{ sourceLabel?: string, carrier?: string, service?: string, trackings?: Array<{ number: string, url?: string, packageLabel?: string, carrier?: string, service?: string }> }} fulfillment
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendAdminShippingNotifyEmail(order, fulfillment) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(order?.customer_email || "").trim();
  if (!key || !from || !to) {
    return { sent: false, reason: !to ? "missing_customer_email" : "resend_not_configured" };
  }

  const fallbackTracking = String(order?.shippo_tracking_number || "").trim();
  const resolvedFulfillment = fulfillment || {
    sourceLabel: "Shippo",
    carrier: String(order?.shippo_label_carrier || "").trim(),
    service: String(order?.shippo_label_service || "").trim(),
    trackings: fallbackTracking
      ? [{
          number: fallbackTracking,
          url: String(order?.shippo_tracking_url_provider || "").trim() || undefined,
          carrier: String(order?.shippo_label_carrier || "").trim() || undefined,
          service: String(order?.shippo_label_service || "").trim() || undefined,
        }]
      : [],
  };
  const trackings = Array.isArray(resolvedFulfillment?.trackings) ? resolvedFulfillment.trackings : [];
  if (!trackings.length || !trackings.some((t) => String(t?.number || "").trim())) {
    return { sent: false, reason: "missing_tracking" };
  }

  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: buildBuyerShippingNotifySubject(order),
    html: buildBuyerShippingNotifyHtml(order, resolvedFulfillment),
    text: buildBuyerShippingNotifyText(order, resolvedFulfillment),
  });

  if (error) {
    console.error("[admin] shipping notify email failed", error);
    return { sent: false, reason: "resend_error" };
  }
  return { sent: true };
}
