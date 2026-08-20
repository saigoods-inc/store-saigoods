import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { rpcInventoryApplyOps } from "./inventory-repo.js";
import { listOrderShippoLabels } from "./order-shippo-labels.js";
import { getOrderByIdForService } from "./orders.js";
import { cancelOrRefundSquarePayment } from "./square-cancellation.js";
import { assertShippoTransactionUnused, getShippoTransaction, requestShippoTransactionRefund } from "./shippo-transaction.js";
import { sendOrderCancellationEmail } from "./order-cancellation-email.js";

function idForQuery(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : text;
}

function cancellationLabels(order, rows) {
  const labels = Array.isArray(rows) ? [...rows] : [];
  const legacy = String(order?.shippo_transaction_id || "").trim();
  if (legacy && !labels.some((row) => String(row.transaction_id || "") === legacy)) {
    labels.push({ id: null, order_id: order.id, parcel_index: 0, status: "purchased", transaction_id: legacy });
  }
  return labels.filter((row) => String(row.status || "").toLowerCase() === "purchased" && String(row.transaction_id || "").trim());
}

async function restoreInventoryExactlyOnce(order, actor, client) {
  const referenceId = String(order.id);
  const { data: previous, error: previousError } = await client
    .from("inventory_movements")
    .select("id")
    .eq("movement_type", "order_cancel_restock")
    .eq("reference_type", "order")
    .eq("reference_id", referenceId)
    .limit(1);
  if (previousError) throw previousError;
  if (previous?.length) return { restored: true, idempotent: true };

  const { data: committed, error } = await client
    .from("inventory_movements")
    .select("variant_id, cases_delta, boxes_delta")
    .eq("movement_type", "order_commit")
    .eq("reference_type", "order")
    .eq("reference_id", referenceId);
  if (error) throw error;
  if (!committed?.length) {
    if (order.inventory_committed_at) {
      const failure = new Error("The payment was refunded, but inventory could not be restored automatically. No original inventory movements were found; review stock manually.");
      failure.code = "INVENTORY_RESTORE_REVIEW";
      throw failure;
    }
    return { restored: false, idempotent: true, reason: "inventory_not_committed" };
  }

  const ops = committed.map((movement) => ({
    variant_id: movement.variant_id,
    cases_delta: -Number(movement.cases_delta || 0),
    boxes_delta: -Number(movement.boxes_delta || 0),
    movement_type: "order_cancel_restock",
    note: `Restored after cancellation of ${order.order_ref || order.id}`,
    reference_type: "order",
    reference_id: referenceId,
    created_by: actor || "admin",
  }));
  await rpcInventoryApplyOps(ops);
  return { restored: true, idempotent: false, movementCount: ops.length };
}

async function updateLabelRefundResult(client, label, result, error) {
  if (!label.id) return;
  const status = String(result?.status || "").toUpperCase();
  const complete = status === "REFUNDED";
  const code = error ? "LABEL_REFUND_ATTENTION" : complete ? "LABEL_REFUNDED" : "LABEL_REFUND_PENDING";
  const message = error
    ? String(error.message || "Label refund needs manual attention.").slice(0, 1000)
    : complete
      ? "Shippo confirmed this label refund."
      : `Shippo label refund requested (${status || "PENDING"}).`;
  const { error: updateError } = await client.from("order_shippo_labels").update({
    last_error_code: code,
    error_message: message,
    updated_at: new Date().toISOString(),
  }).eq("id", label.id);
  if (updateError) throw updateError;
}

/** Production-safe, idempotent cancellation workflow. */
export async function cancelPaidOrder({ orderId, reason, actor }, dependencies = {}) {
  const client = dependencies.client || getSupabaseServiceRoleClient();
  const loadOrder = dependencies.loadOrder || getOrderByIdForService;
  const loadLabels = dependencies.loadLabels || listOrderShippoLabels;
  const square = dependencies.square || cancelOrRefundSquarePayment;
  const getTransaction = dependencies.getTransaction || getShippoTransaction;
  const refundTransaction = dependencies.refundTransaction || requestShippoTransactionRefund;
  const restoreInventory = dependencies.restoreInventory || ((order) => restoreInventoryExactlyOnce(order, actor, client));
  const sendEmail = dependencies.sendEmail || sendOrderCancellationEmail;
  const normalizedReason = String(reason || "").trim();
  if (!String(orderId || "").trim()) throw Object.assign(new Error("orderId is required."), { statusCode: 400 });
  if (normalizedReason.length < 3) throw Object.assign(new Error("Enter a cancellation reason."), { statusCode: 400 });

  let order = await loadOrder(orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  const source = String(order.order_source || "").toLowerCase();
  const paymentId = String(order.payment_id || "");
  if (!paymentId || !["web", "online", "manual"].includes(source) || paymentId.startsWith("manual_in_person:")) {
    throw Object.assign(new Error("Only Square-paid online or manual orders can use automated cancellation."), { statusCode: 409 });
  }
  const workflow = String(order.order_status || "").toLowerCase();
  const tracking = String(order.shippo_tracking_status || "").toLowerCase();
  if (workflow === "shipped" || ["transit", "in_transit", "delivered"].includes(tracking)) {
    throw Object.assign(new Error("This order has already shipped. Handle the return before issuing a refund."), { statusCode: 409 });
  }
  if (!["paid", "cancellation_pending", "refund_pending", "refunded"].includes(String(order.status || "").toLowerCase())) {
    throw Object.assign(new Error("This order does not have a refundable paid status."), { statusCode: 409 });
  }

  const startingStatus = String(order.status).toLowerCase();
  if (startingStatus === "paid") {
    const now = new Date().toISOString();
    const { data, error } = await client.from("orders").update({
      status: "cancellation_pending",
      payment_reconciliation_required: true,
      payment_reconciliation_error: "Cancellation is in progress.",
      updated_at: now,
    }).eq("id", idForQuery(order.id)).eq("status", "paid").select("*").maybeSingle();
    if (error) throw error;
    order = data || await loadOrder(order.id);
    if (!order || !["cancellation_pending", "refund_pending", "refunded"].includes(String(order.status || "").toLowerCase())) {
      throw Object.assign(new Error("This order changed while cancellation was starting. Refresh and review it."), { statusCode: 409 });
    }
  } else if (["cancellation_pending", "refund_pending"].includes(startingStatus)) {
    const updatedAt = order.updated_at ? new Date(order.updated_at).getTime() : 0;
    if (startingStatus === "cancellation_pending" && updatedAt && Date.now() - updatedAt < 2 * 60 * 1000) {
      throw Object.assign(new Error("Cancellation is already processing. Wait two minutes before retrying."), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    let claim = client.from("orders").update({ updated_at: now }).eq("id", idForQuery(order.id)).eq("status", startingStatus);
    if (order.updated_at) claim = claim.eq("updated_at", order.updated_at);
    const { data, error } = await claim.select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Cancellation is already being retried by another admin. Refresh this order."), { statusCode: 409 });
    order = data;
  }

  let labels;
  try {
    const allLabelRows = await loadLabels(order.id);
    const activePurchase = allLabelRows.find((row) => ["pending", "processing", "retry", "unknown"].includes(String(row.status || "").toLowerCase()));
    if (activePurchase) {
      throw Object.assign(new Error("A shipping label purchase is still processing or unresolved. Wait for it to finish before cancelling."), { statusCode: 409 });
    }
    labels = cancellationLabels(order, allLabelRows);
    for (const label of labels) {
      const transaction = await getTransaction(label.transaction_id);
      if (!transaction) throw Object.assign(new Error("A purchased label could not be verified with Shippo. No refund was attempted."), { statusCode: 502 });
      assertShippoTransactionUnused(transaction);
    }
  } catch (error) {
    if (startingStatus === "paid") {
      await client.from("orders").update({
        status: "paid",
        payment_reconciliation_required: false,
        payment_reconciliation_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", idForQuery(order.id)).eq("status", "cancellation_pending");
    }
    throw error;
  }

  let squareResult;
  try {
    squareResult = await square({ paymentId: order.payment_id, amountCents: order.total_cents, orderId: order.id, reason: normalizedReason });
  } catch (error) {
    await client.from("orders").update({
      payment_reconciliation_required: true,
      payment_reconciliation_error: `Cancellation stopped before inventory restoration: ${String(error.message || "Square refund failed.").slice(0, 700)}`,
      updated_at: new Date().toISOString(),
    }).eq("id", idForQuery(order.id));
    throw error;
  }

  let inventory;
  try {
    inventory = await restoreInventory(order);
  } catch (error) {
    await client.from("orders").update({
      status: "refund_pending",
      order_status: "cancelled",
      payment_reconciliation_required: true,
      payment_reconciliation_error: String(error.message || "Refund accepted; inventory restoration needs attention.").slice(0, 900),
      updated_at: new Date().toISOString(),
    }).eq("id", idForQuery(order.id));
    throw error;
  }

  const shippingRefunds = [];
  for (const label of labels) {
    try {
      const result = await refundTransaction(label.transaction_id);
      await updateLabelRefundResult(client, label, result, null);
      shippingRefunds.push({ transactionId: label.transaction_id, ok: true, status: result.status, refundId: result.refundId || null });
    } catch (error) {
      await updateLabelRefundResult(client, label, null, error);
      shippingRefunds.push({ transactionId: label.transaction_id, ok: false, status: "ATTENTION", error: String(error.message || "Label refund failed.") });
    }
  }

  const squarePending = String(squareResult.status || "").toUpperCase() === "PENDING";
  const labelAttention = shippingRefunds.some((item) => !item.ok);
  const labelPending = shippingRefunds.some((item) => item.ok && !["REFUNDED"].includes(String(item.status || "").toUpperCase()));
  const warningParts = [];
  if (squarePending) warningParts.push("Square accepted the refund and is still processing it.");
  if (labelAttention) warningParts.push("At least one shipping label refund needs manual review in Shippo or the connected UPS account.");
  else if (labelPending) warningParts.push("Shippo accepted the label refund request; carrier credit is pending.");
  const now = new Date().toISOString();
  const finalStatus = squarePending ? "refund_pending" : "refunded";
  const { data: updated, error: updateError } = await client.from("orders").update({
    status: finalStatus,
    order_status: "cancelled",
    payment_reconciliation_required: squarePending,
    payment_reconciliation_error: squarePending ? "Square refund is pending settlement." : null,
    label_workflow_error_code: labelAttention ? "CANCELLED_LABEL_REFUND_ATTENTION" : labelPending ? "CANCELLED_LABEL_REFUND_PENDING" : null,
    label_workflow_updated_at: now,
    shippo_label_sync_error: labelAttention ? warningParts.at(-1) : null,
    updated_at: now,
  }).eq("id", idForQuery(order.id)).select("*").maybeSingle();
  if (updateError) throw updateError;
  await client.from("shipping_state_events").insert({
    order_id: idForQuery(order.id),
    correlation_id: order.checkout_quote_correlation_id || null,
    from_status: workflow || null,
    to_status: "cancelled",
    reason_code: `CUSTOMER_CANCELLED: ${normalizedReason}`.slice(0, 500),
  });

  let notification = { sent: false, reason: "send_failed" };
  try {
    notification = await sendEmail(updated || order, squareResult);
    if (notification.sent) {
      const emailSentAt = new Date().toISOString();
      const { error: emailTrackingError } = await client.from("orders").update({
        cancellation_email_sent_at: emailSentAt,
        cancellation_email_resend_id: String(notification.id || "").trim() || null,
        updated_at: emailSentAt,
      }).eq("id", idForQuery(order.id));
      if (emailTrackingError) warningParts.push("The cancellation email was sent, but its delivery record could not be saved.");
    }
  } catch {
    warningParts.push("The cancellation email could not be sent.");
  }
  const refreshedLabels = await loadLabels(order.id);
  return {
    ok: true,
    complete: !squarePending && !labelAttention && !labelPending,
    order: updated || order,
    labels: refreshedLabels,
    square: squareResult,
    inventory,
    shippingRefunds,
    notified: notification.sent === true,
    warning: warningParts.join(" ") || null,
  };
}
