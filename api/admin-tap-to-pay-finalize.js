import { getOrderByIdForService, markManualTapToPayOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import { assertCompletedSquarePaymentMatchesOrder } from "../lib/square-payment-verification.js";
import {
  assertTapToPayActor,
  assertTapToPayEnabled,
  retrieveTapToPayPayment,
  verifyTapToPayState,
} from "../lib/tap-to-pay.js";

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
    const stateToken = String(req.body?.state || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();
    const simulation = req.body?.simulation === true;
    if (!stateToken || !transactionId) throw withStatus("Tap to Pay callback is incomplete.", 400);
    const state = verifyTapToPayState(stateToken, config.stateSecret, { actorEmail });
    const order = await getOrderByIdForService(state.oid);
    if (!order) throw withStatus("Order not found.", 404);
    if (Math.round(Number(order.total_cents)) !== state.amt) {
      throw withStatus("Order total changed after Tap to Pay started. Start payment again.", 409);
    }

    let payment;
    if (simulation) {
      if (!config.simulationEnabled || !transactionId.startsWith("sim_")) {
        throw withStatus("Tap to Pay simulation is not enabled.", 403);
      }
      payment = {
        id: `staging_${transactionId}`,
        status: "COMPLETED",
        amount_money: { amount: state.amt, currency: "USD" },
        location_id: config.locationId,
        note: `Order ${state.oid} from SAI Goods Tap to Pay staging simulation`,
        created_at: new Date().toISOString(),
        card_details: { entry_method: "CONTACTLESS" },
        processing_fee: [{ amount_money: { amount: 0, currency: "USD" } }],
      };
    } else {
      ({ payment } = await retrieveTapToPayPayment(transactionId, config));
    }

    if (String(payment.location_id || "") !== config.locationId) {
      throw withStatus("Square payment location does not match Tap to Pay staging.", 409);
    }
    if (!payment.card_details) {
      throw withStatus("Square transaction is not a card payment.", 409);
    }
    assertCompletedSquarePaymentMatchesOrder(payment, {
      orderId: state.oid,
      amountCents: state.amt,
      currency: "USD",
    });
    const updated = await markManualTapToPayOrderPaid({
      orderId: state.oid,
      payment,
      actorEmail,
    });
    res.status(200).json({
      ok: true,
      order: updated,
      idempotent: updated.idempotent === true,
      paymentId: payment.id,
      entryMethod: payment.card_details?.entry_method || null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message || "Tap to Pay could not be verified.",
      code: error.code || null,
      retrySafe: error.retrySafe === true,
    });
  }
}

function withStatus(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
