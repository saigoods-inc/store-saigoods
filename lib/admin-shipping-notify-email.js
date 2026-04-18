import { Resend } from "resend";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sends a simple “your order shipped” email with tracking when Resend is configured.
 * @param {object} order — DB row with customer_email, order_ref, shippo_tracking_number, shippo_tracking_url_provider
 * @returns {{ sent: boolean, reason?: string }}
 */
export async function sendAdminShippingNotifyEmail(order) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(order?.customer_email || "").trim();
  if (!key || !from || !to) {
    return { sent: false, reason: !to ? "missing_customer_email" : "resend_not_configured" };
  }

  const ref = escapeHtml(order?.order_ref || "Your order");
  const track = String(order?.shippo_tracking_number || "").trim();
  const trackUrl = String(order?.shippo_tracking_url_provider || "").trim();
  const carrier = escapeHtml(order?.shippo_label_carrier || "");
  const service = escapeHtml(order?.shippo_label_service || "");

  const trackBlock = track
    ? trackUrl
      ? `<p><strong>Tracking:</strong> <a href="${escapeHtml(trackUrl)}">${escapeHtml(track)}</a></p>`
      : `<p><strong>Tracking:</strong> ${escapeHtml(track)}</p>`
    : "";

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222">
<p>Hello,</p>
<p>Your order <strong>${ref}</strong> has shipped${carrier ? ` via ${carrier}` : ""}${service ? ` (${service})` : ""}.</p>
${trackBlock}
<p>Thank you for shopping with SAI Goods.</p>
</body></html>`;

  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Shipped — ${String(order?.order_ref || "SAI Goods order")}`,
    html,
  });

  if (error) {
    console.error("[admin] shipping notify email failed", error);
    return { sent: false, reason: "resend_error" };
  }
  return { sent: true };
}
