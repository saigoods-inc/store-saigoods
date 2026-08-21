import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { listOrderShippoLabels } from "./order-shippo-labels.js";
import { getOrderByIdForService } from "./orders.js";
import { getSquarePayment, listSquarePaymentRefunds } from "./square-cancellation.js";
import { getShippoTransaction } from "./shippo-transaction.js";

function idForQuery(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : text;
}

function squareRefundState(payment, refunds, totalCents) {
  const expected = Math.max(0, Math.round(Number(totalCents) || 0));
  const refunded = Math.max(0, Number(payment?.refunded_money?.amount) || 0);
  const relevant = refunds
    .filter((refund) => String(refund?.payment_id || "") === String(payment?.id || ""))
    .sort((left, right) => String(right?.updated_at || right?.created_at || "").localeCompare(String(left?.updated_at || left?.created_at || "")));
  const refund = relevant[0] || null;
  const status = String(refund?.status || "").toUpperCase();
  if (refunded >= expected && expected > 0) return { state: "complete", status: status || "COMPLETED" };
  if (["COMPLETED", "APPROVED"].includes(status)) return { state: "complete", status };
  if (["FAILED", "REJECTED"].includes(status)) return { state: "attention", status };
  return { state: "pending", status: status || "PENDING" };
}

function shippoRefundState(transaction) {
  const status = String(transaction?.status || "").toUpperCase();
  if (status === "REFUNDED") return { state: "complete", status };
  if (["REFUNDPENDING", "QUEUED", "PENDING"].includes(status)) return { state: "pending", status };
  return { state: "attention", status: status || "UNKNOWN" };
}

/** Reconcile an already-cancelled order without issuing another refund or restoring stock again. */
export async function reconcileCancelledOrder(orderId, dependencies = {}) {
  const client = dependencies.client || getSupabaseServiceRoleClient();
  const loadOrder = dependencies.loadOrder || getOrderByIdForService;
  const loadLabels = dependencies.loadLabels || listOrderShippoLabels;
  const getPayment = dependencies.getPayment || getSquarePayment;
  const listRefunds = dependencies.listRefunds || listSquarePaymentRefunds;
  const getTransaction = dependencies.getTransaction || getShippoTransaction;

  const order = await loadOrder(orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  if (String(order.order_status || "").toLowerCase() !== "cancelled") {
    throw Object.assign(new Error("Only cancelled orders can be reconciled."), { statusCode: 409 });
  }
  const paymentId = String(order.payment_id || "").trim();
  if (!paymentId) throw Object.assign(new Error("This order has no Square payment to reconcile."), { statusCode: 409 });

  const [payment, refunds, labels] = await Promise.all([
    getPayment(paymentId),
    listRefunds(paymentId),
    loadLabels(order.id),
  ]);
  const square = squareRefundState(payment, refunds, order.total_cents);
  const shippingRefunds = [];

  for (const label of labels) {
    const transactionId = String(label.transaction_id || "").trim();
    if (!transactionId) continue;
    const transaction = await getTransaction(transactionId);
    const state = shippoRefundState(transaction);
    const code = state.state === "complete" ? "LABEL_REFUNDED" : state.state === "pending" ? "LABEL_REFUND_PENDING" : "LABEL_REFUND_ATTENTION";
    const message = state.state === "complete"
      ? "Shippo confirmed this label refund."
      : state.state === "pending"
        ? `Shippo label refund is pending (${state.status}).`
        : `Shippo label refund needs review (${state.status}).`;
    if (label.id) {
      const { error } = await client.from("order_shippo_labels").update({
        last_error_code: code,
        error_message: message,
        updated_at: new Date().toISOString(),
      }).eq("id", label.id);
      if (error) throw error;
    }
    shippingRefunds.push({ state: state.state, status: state.status });
  }

  const labelAttention = shippingRefunds.some((item) => item.state === "attention");
  const labelPending = shippingRefunds.some((item) => item.state === "pending");
  const now = new Date().toISOString();
  const paymentError = square.state === "attention"
    ? `Square refund needs review (${square.status}).`
    : square.state === "pending"
      ? "Square refund is pending settlement."
      : null;
  const { data: updated, error: updateError } = await client.from("orders").update({
    status: square.state === "complete" ? "refunded" : "refund_pending",
    payment_reconciliation_required: square.state !== "complete",
    payment_reconciliation_error: paymentError,
    label_workflow_error_code: labelAttention
      ? "CANCELLED_LABEL_REFUND_ATTENTION"
      : labelPending
        ? "CANCELLED_LABEL_REFUND_PENDING"
        : null,
    label_workflow_updated_at: now,
    shippo_label_sync_error: labelAttention ? "A shipping-label refund needs manual review." : null,
    updated_at: now,
  }).eq("id", idForQuery(order.id)).select("*").maybeSingle();
  if (updateError) throw updateError;

  return {
    ok: true,
    order: updated || order,
    labels: await loadLabels(order.id),
    square,
    shippingRefunds,
    complete: square.state === "complete" && !labelPending && !labelAttention,
    warning: square.state === "attention" || labelAttention
      ? "One or more refunds need manual review."
      : square.state === "pending" || labelPending
        ? "Refund processing is still pending. No duplicate request was submitted."
        : null,
  };
}

export const cancellationStatusInternals = { squareRefundState, shippoRefundState };
