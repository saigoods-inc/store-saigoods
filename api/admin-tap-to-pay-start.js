import { getOrderByIdForService } from "../lib/orders.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import {
  assertTapToPayActor,
  assertTapToPayEnabled,
  buildTapToPayUrls,
  createTapToPayState,
} from "../lib/tap-to-pay.js";

export function assertOrderCanStartTapToPay(order) {
  if (!order) throw withStatus("Order not found.", 404);
  if (
    String(order.order_source || "") !== "manual" ||
    String(order.fulfillment_method || "") !== "local_delivery" ||
    String(order.payment_flow || "") !== "pay_later" ||
    String(order.manual_payment_method || "") !== "tap_to_pay"
  ) {
    throw withStatus("This order is not configured for Tap to Pay staging.", 400);
  }
  if (String(order.status || "") === "paid") throw withStatus("This order is already paid.", 409);
  if (String(order.order_status || "") !== "draft") {
    throw withStatus("Only an unpaid draft order can start Tap to Pay.", 409);
  }
  const amountCents = Math.round(Number(order.total_cents));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw withStatus("Order total must be greater than zero.", 400);
  }
  return amountCents;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    const config = assertTapToPayEnabled();
    const actor = await getReportsActor(req);
    const actorEmail = assertTapToPayActor(actor, config);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) throw withStatus("orderId is required.", 400);
    const order = await getOrderByIdForService(orderId);
    const amountCents = assertOrderCanStartTapToPay(order);
    const state = createTapToPayState({ orderId, amountCents, actorEmail }, config.stateSecret);
    const urls = buildTapToPayUrls({
      config,
      orderId,
      orderRef: order.order_ref,
      amountCents,
      state,
    });
    const simulationUrl = new URL(config.callbackUrl);
    simulationUrl.searchParams.set("tap_to_pay_simulation", "success");
    simulationUrl.searchParams.set("tap_to_pay_state", state);
    simulationUrl.searchParams.set("tap_to_pay_transaction_id", `sim_${Date.now()}`);
    res.status(200).json({
      ok: true,
      orderId,
      orderRef: order.order_ref,
      amountCents,
      state,
      ...urls,
      simulationUrl: config.simulationEnabled ? simulationUrl.toString() : null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Could not start Tap to Pay." });
  }
}

function withStatus(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
