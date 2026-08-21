import { Resend } from "resend";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCurrency(cents) {
  return (Math.max(0, Number(cents) || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function firstName(order) {
  return String(order?.customer_name || "").trim().split(/\s+/)[0] || "there";
}

function cancellationDetails(order, squareResult) {
  const action = String(squareResult?.action || "refund").toLowerCase();
  const status = String(squareResult?.status || "").toUpperCase();
  const total = formatCurrency(order?.total_cents);

  if (action === "void") {
    return {
      total,
      statusLabel: "Payment authorization released",
      summary: `The ${total} payment authorization was cancelled before it settled.`,
      timing: "Your bank may take several business days to remove the pending authorization.",
      preheader: `Your order was cancelled and the ${total} payment authorization was released.`,
    };
  }

  if (status === "PENDING") {
    return {
      total,
      statusLabel: "Refund processing",
      summary: `Your ${total} refund was submitted to Square and is processing.`,
      timing: "Your bank may take several business days to post the credit.",
      preheader: `Your order was cancelled and your ${total} refund is processing.`,
    };
  }

  return {
    total,
    statusLabel: "Refund issued",
    summary: `A ${total} refund has been issued to your original payment method.`,
    timing: "Your bank may take several business days to post the credit.",
    preheader: `Your order was cancelled and a ${total} refund was issued.`,
  };
}

export function buildOrderCancellationSubject(order) {
  const reference = String(order?.order_ref || order?.id || "your order");
  return `Order cancelled — ${reference}`;
}

export function buildOrderCancellationText(order, squareResult) {
  const reference = String(order?.order_ref || order?.id || "your order");
  const details = cancellationDetails(order, squareResult);
  return [
    `Hi ${firstName(order)},`,
    "",
    "Your SAI Goods order has been cancelled.",
    "",
    `Order reference: ${reference}`,
    `Amount: ${details.total}`,
    `Status: ${details.statusLabel}`,
    "",
    details.summary,
    details.timing,
    "",
    "You do not need to take any action.",
    "",
    "Questions? Email sales@saigoods.com and we will help.",
    "",
    "SAI Goods, Inc.",
  ].join("\n");
}

export function buildOrderCancellationHtml(order, squareResult) {
  const reference = String(order?.order_ref || order?.id || "your order");
  const details = cancellationDetails(order, squareResult);
  const greeting = firstName(order);

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f6f1ed;color:#2b2927;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(details.preheader)}</div>
  <div style="padding:28px 14px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #eadfd8;border-radius:18px;overflow:hidden;">
      <div style="padding:22px 22px 18px;border-bottom:1px solid #eadfd8;background:#fffaf7;">
        <div style="font-size:13px;line-height:18px;font-weight:800;color:#cf5849;">SAI Goods, Inc.</div>
        <h1 style="margin:12px 0 0;font-size:28px;line-height:34px;font-weight:800;color:#2b2927;">Your order has been cancelled</h1>
      </div>
      <div style="padding:22px;">
        <p style="margin:0;font-size:16px;line-height:24px;color:#5f5650;">Hi ${escapeHtml(greeting)},</p>
        <p style="margin:14px 0 0;font-size:16px;line-height:25px;color:#5f5650;">We have cancelled your SAI Goods order as requested.</p>
        <div style="margin-top:20px;border:1px solid #eadfd8;border-radius:10px;padding:18px;background:#fbf8f6;">
          <div style="font-size:12px;line-height:16px;font-weight:800;color:#8b817b;text-transform:uppercase;letter-spacing:.04em;">Refund status</div>
          <div style="margin-top:8px;font-size:21px;line-height:28px;font-weight:800;color:#2b2927;">${escapeHtml(details.statusLabel)}</div>
          <div style="margin-top:4px;font-size:28px;line-height:34px;font-weight:800;color:#cf5849;">${escapeHtml(details.total)}</div>
          <p style="margin:12px 0 0;font-size:14px;line-height:22px;color:#5f5650;">${escapeHtml(details.summary)} ${escapeHtml(details.timing)}</p>
        </div>
        <div style="margin-top:18px;border:1px solid #eadfd8;border-radius:10px;padding:16px;background:#ffffff;">
          <div style="font-size:12px;line-height:16px;font-weight:800;color:#8b817b;text-transform:uppercase;letter-spacing:.04em;">Order summary</div>
          <div style="margin-top:12px;font-size:13px;line-height:18px;color:#8b817b;">Order reference</div>
          <div style="font-size:17px;line-height:24px;font-weight:800;color:#2b2927;word-break:break-word;">${escapeHtml(reference)}</div>
          <div style="margin-top:10px;font-size:13px;line-height:18px;color:#8b817b;">Refund amount</div>
          <div style="font-size:16px;line-height:23px;font-weight:800;color:#2b2927;">${escapeHtml(details.total)}</div>
        </div>
        <div style="margin-top:18px;border-radius:8px;padding:13px 15px;background:#fff4cf;color:#6b5100;font-size:14px;line-height:21px;font-weight:700;">You do not need to take any action.</div>
        <div style="margin-top:22px;border-top:1px solid #eadfd8;padding-top:18px;">
          <p style="margin:0;font-size:12px;line-height:19px;color:#8b817b;">Questions about this cancellation? Email <a href="mailto:sales@saigoods.com" style="color:#cf5849;text-decoration:none;font-weight:800;">sales@saigoods.com</a> and we will help.</p>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export async function sendOrderCancellationEmail(order, squareResult, options = {}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(order?.customer_email || "").trim();
  if (!apiKey || !from || !to) return { sent: false, reason: to ? "not_configured" : "missing_customer_email" };
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: buildOrderCancellationSubject(order),
    html: buildOrderCancellationHtml(order, squareResult),
    text: buildOrderCancellationText(order, squareResult),
  }, {
    idempotencyKey: String(
      options.idempotencyKey || `order-cancelled/${String(order.payment_id || order.id)}`,
    ).slice(0, 256),
  });
  if (error) throw new Error(error.message || "Cancellation email failed.");
  return { sent: true };
}
