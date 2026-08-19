import { getOrderByIdForService, markOrderPaid } from "./orders.js";
import { sendPaidOrderReceiptResendIfConfigured } from "./send-paid-order-receipt-resend.js";
import { syncWebsiteOrderToShippo } from "./shippo-order-sync.js";
import {
  extractBuyerContactFromPayment,
  formatPaymentShippingAddress,
  verifySquareSignature,
} from "./square.js";
import { sendVendorPaidOrderNotificationIfNeeded } from "./vendor-paid-order-notification.js";
import { assertCompletedSquarePaymentMatchesOrder } from "./square-payment-verification.js";
import { processAutomaticLabelsForOrder } from "./automatic-label-worker.js";
import { processAutomaticManualLabels } from "./automatic-manual-label-worker.js";
import { recordSquareWebhookEvent } from "./square-webhook-events.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export function resolveSquareNotificationUrl({
  baseUrl,
  notificationPath,
  vercelEnv = process.env.VERCEL_ENV,
  automationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
}) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/$/, "");
  const normalizedPath = String(notificationPath || "").startsWith("/")
    ? String(notificationPath || "")
    : `/${String(notificationPath || "")}`;
  const notificationUrl = new URL(`${normalizedBaseUrl}${normalizedPath}`);
  const bypassSecret = String(automationBypassSecret || "").trim();

  // Square signs the exact notification URL, including its query string. A
  // protected Preview therefore needs the Vercel automation-bypass parameter
  // included in signature verification. Production URLs stay clean and public.
  if (String(vercelEnv || "").toLowerCase() === "preview" && bypassSecret) {
    notificationUrl.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }

  return notificationUrl.toString();
}

/**
 * Shared Square webhook logic for production and sandbox URLs.
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ notificationPath: string, signatureKey: string }} opts
 *   notificationPath — path only, e.g. "/api/webhooks/square" (must match Square subscription URL)
 *   signatureKey — HMAC key from Square for this subscription
 * @param {object} [dependencies] — optional overrides for tests. Production wrappers
 *   provide Vercel's waitUntil as `defer` so label work survives the webhook response.
 */
export async function handleSquareWebhook(
  req,
  res,
  { notificationPath, signatureKey },
  dependencies = {},
) {
  const verifySquareSignatureFn = dependencies.verifySquareSignature ?? verifySquareSignature;
  const extractBuyerContactFromPaymentFn =
    dependencies.extractBuyerContactFromPayment ?? extractBuyerContactFromPayment;
  const formatPaymentShippingAddressFn =
    dependencies.formatPaymentShippingAddress ?? formatPaymentShippingAddress;
  const markOrderPaidFn = dependencies.markOrderPaid ?? markOrderPaid;
  const getOrderByIdForServiceFn = dependencies.getOrderByIdForService ?? getOrderByIdForService;
  const syncWebsiteOrderToShippoFn = dependencies.syncWebsiteOrderToShippo ?? syncWebsiteOrderToShippo;
  const sendVendorPaidOrderNotificationIfNeededFn =
    dependencies.sendVendorPaidOrderNotificationIfNeeded ?? sendVendorPaidOrderNotificationIfNeeded;
  const sendPaidOrderReceiptResendIfConfiguredFn =
    dependencies.sendPaidOrderReceiptResendIfConfigured ?? sendPaidOrderReceiptResendIfConfigured;
  const processAutomaticLabelsForOrderFn =
    dependencies.processAutomaticLabelsForOrder ?? processAutomaticLabelsForOrder;
  const processAutomaticManualLabelsFn =
    dependencies.processAutomaticManualLabels ?? processAutomaticManualLabels;
  const recordSquareWebhookEventFn = dependencies.recordSquareWebhookEvent ?? recordSquareWebhookEvent;
  const deferFn = dependencies.defer ?? ((promise) => void promise);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-square-hmacsha256-signature"];

    const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!baseUrl) {
      res.status(500).json({ error: "PUBLIC_BASE_URL is not configured." });
      return;
    }

    const notificationUrl = resolveSquareNotificationUrl({ baseUrl, notificationPath });

    const valid = verifySquareSignatureFn({
      body: rawBody,
      signature,
      notificationUrl,
      signatureKey,
    });

    if (!valid) {
      res.status(403).json({ error: "Invalid signature." });
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }

    const eventType = String(event?.type || "");
    if (eventType && !eventType.startsWith("payment.")) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const payment = extractPaymentFromSquareEvent(event);
    if (!payment) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (payment.status !== "COMPLETED") {
      res.status(200).json({ ok: true });
      return;
    }

    const paymentId = payment.id;
    const note = payment.note || "";

    const orderIdMatch = note.match(/Order\s+(\S+)\s+from/i);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;

    if (!orderId) {
      res.status(200).json({ ok: true });
      return;
    }

    const dedupe = await recordSquareWebhookEventFn({
      eventId: event?.event_id || event?.id || null,
      paymentId,
      orderId,
    });
    if (!dedupe.inserted) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const paidTotalCents = payment.amount_money?.amount;
    const contact = extractBuyerContactFromPaymentFn(payment);
    const transitionedOrder = await markOrderPaidFn({
      orderId,
      paymentId,
      paidTotalCents:
        paidTotalCents != null && Number.isFinite(Number(paidTotalCents))
          ? Number(paidTotalCents)
          : undefined,
      customerAddress: formatPaymentShippingAddressFn(payment),
      buyerEmail: contact.email,
      buyerPhone: contact.phone,
      buyerName: contact.name,
      payment,
    });

    let fetchedOrder = null;
    if (!transitionedOrder) {
      fetchedOrder = await getOrderByIdForServiceFn(orderId);
    }

    const order = transitionedOrder || fetchedOrder;

    if (!order || order.status !== "paid" || String(order.payment_id) !== String(paymentId)) {
      res.status(200).json({ ok: true });
      return;
    }
    if (Number.isFinite(Number(order.total_cents))) {
      assertCompletedSquarePaymentMatchesOrder(
        {
          ...payment,
          amount_money: {
            ...payment.amount_money,
            currency: payment.amount_money?.currency || "USD",
          },
        },
        {
          orderId,
          amountCents: order.total_cents,
          currency: order.quoted_shipping_currency || "USD",
        },
      );
    }

    if (transitionedOrder && process.env.ENABLE_SHIPPO_ORDER_SYNC === "true") {
      const shippoSync = await syncWebsiteOrderToShippoFn(order.id);
      if (!shippoSync.ok && !shippoSync.skipped) {
        console.error("[shippo] webhook-triggered sync failed:", shippoSync.error || shippoSync.reason || "unknown");
      }
    }

    if (String(order.order_source || "") === "web") {
      const automaticLabelTask = processAutomaticLabelsForOrderFn(order.id).catch((error) => {
        console.error("[shipping] webhook label worker deferred to recovery", {
          orderId: order.id,
          code: String(error?.code || "AUTOMATIC_LABEL_WORKER_FAILED").slice(0, 64),
        });
      });
      deferFn(automaticLabelTask);
    }

    if (
      String(order.order_source || "") === "manual" &&
      String(order.payment_flow || "") === "square_payment_link" &&
      String(order.fulfillment_method || "carrier") === "carrier" &&
      order.shippo_label_required !== false
    ) {
      const automaticManualLabelTask = processAutomaticManualLabelsFn(order.id).catch((error) => {
        console.error("[shipping] manual-order label worker deferred to recovery", {
          orderId: order.id,
          code: String(error?.code || "AUTOMATIC_MANUAL_LABEL_WORKER_FAILED").slice(0, 64),
        });
      });
      deferFn(automaticManualLabelTask);
    }

    await sendVendorPaidOrderNotificationIfNeededFn({ orderId: order.id, paymentId });

    if (transitionedOrder && String(order.order_source || "") === "manual") {
      const receiptResult = await sendPaidOrderReceiptResendIfConfiguredFn(order);
      if (receiptResult.sent === false && receiptResult.reason === "error") {
        console.error("[square webhook] Resend receipt:", receiptResult.message || receiptResult.reason);
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    logSquareWebhookFailure(error);
    res.status(500).json({ error: "Webhook handling failed." });
  }
}

const SAFE_ERROR_CODE_MAX_LEN = 64;

/**
 * Log only a fixed message plus validated code/statusCode — never message, stack, or provider payloads.
 * @param {unknown} error
 */
function logSquareWebhookFailure(error) {
  const details = { code: "UNCLASSIFIED_ERROR" };

  if (error && typeof error === "object") {
    const rawCode = "code" in error ? error.code : undefined;
    if (typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) && rawCode.length <= SAFE_ERROR_CODE_MAX_LEN) {
      details.code = rawCode;
    }

    const rawStatus = "statusCode" in error ? error.statusCode : undefined;
    if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
      details.statusCode = rawStatus;
    }
  }

  console.error("[square webhook] handler failed", details);
}

/** Square webhook payloads nest payment under data.object.payment; tolerate variants. */
function extractPaymentFromSquareEvent(event) {
  if (!event?.data?.object) {
    return null;
  }

  const obj = event.data.object;

  if (obj.payment && typeof obj.payment === "object") {
    return obj.payment;
  }

  if (obj.id && obj.status && obj.amount_money) {
    return obj;
  }

  return null;
}
