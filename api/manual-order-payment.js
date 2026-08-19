import { getOrderByIdForService } from "../lib/orders.js";
import { verifyManualPaymentAccessToken } from "../lib/manual-payment-link-access.js";

function respond(res, status, message) {
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>SAI Goods payment link</title></head><body style="font-family:system-ui;padding:40px;max-width:680px;margin:auto"><h1>${status === 410 ? "Payment link expired" : "Payment link unavailable"}</h1><p>${message}</p></body></html>`);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  const verified = verifyManualPaymentAccessToken(req.query?.token);
  if (!verified.ok) {
    respond(res, verified.reason === "expired" ? 410 : 400, verified.reason === "expired" ? "Please contact SAI Goods so an administrator can resend a new payment link." : "This payment link is invalid.");
    return;
  }
  const order = await getOrderByIdForService(verified.payload.orderId);
  if (!order || String(order.order_source || "") !== "manual") {
    respond(res, 404, "This order could not be found.");
    return;
  }
  if (String(order.status || "").toLowerCase() === "paid") {
    respond(res, 410, "This order has already been paid.");
    return;
  }
  const expiresMs = new Date(order.payment_link_expires_at || 0).getTime();
  if (!Number.isFinite(expiresMs) || Date.now() > expiresMs || Number(verified.payload.exp) !== expiresMs) {
    respond(res, 410, "Please contact SAI Goods so an administrator can resend a new payment link.");
    return;
  }
  const squareUrl = String(order.payment_link_url || "").trim();
  if (!/^https:\/\//i.test(squareUrl)) {
    respond(res, 410, "Please contact SAI Goods so an administrator can resend a new payment link.");
    return;
  }
  res.status(302).setHeader("Location", squareUrl);
  res.end();
}
