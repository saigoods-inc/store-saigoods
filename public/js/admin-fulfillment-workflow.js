/**
 * Single source for admin guided fulfillment (5 steps).
 * Keep in sync with server checks in lib/orders.js (checkpoints + handoff).
 */

export const FULFILLMENT_STEP_LABELS = [
  "Order created & paid",
  "Label purchased",
  "Print label",
  "Summary",
  "Status update",
];

export function orderLabelPurchased(row) {
  return (
    Boolean(String(row?.shippo_label_url || "").trim()) &&
    String(row?.shippo_transaction_status || "").toUpperCase() === "SUCCESS"
  );
}

export function isOrderCancelled(row) {
  return String(row?.order_status || "") === "cancelled";
}

export function isPaymentPaid(row) {
  return String(row?.status || "").toLowerCase() === "paid";
}

/**
 * @returns {number} 0–4 active step, 5 = all complete, -1 = not in guided flow (unpaid / cancelled pre-flow)
 */
export function deriveActiveFulfillmentStepIndex(row) {
  if (!row || isOrderCancelled(row)) {
    return -1;
  }
  if (!isPaymentPaid(row)) {
    return -1;
  }
  if (!orderLabelPurchased(row)) {
    return 1;
  }
  if (!row.admin_fulfillment_print_done_at) {
    return 2;
  }
  if (!row.admin_fulfillment_summary_done_at) {
    return 3;
  }
  if (!row.admin_handoff_at && String(row.order_status || "") !== "shipped") {
    return 4;
  }
  return 5;
}

export function canNavigateToFulfillmentTab(row, tabIndex) {
  const a = deriveActiveFulfillmentStepIndex(row);
  if (a < 0) {
    return tabIndex === 0;
  }
  if (a >= 5) {
    return tabIndex >= 0 && tabIndex <= 4;
  }
  return tabIndex >= 0 && tabIndex <= a;
}

export function canEditFulfillmentTab(row, tabIndex) {
  const a = deriveActiveFulfillmentStepIndex(row);
  if (a < 0 || a >= 5) {
    return false;
  }
  return tabIndex === a;
}

export function fulfillmentTabDone(row, tabIndex) {
  if (tabIndex === 0) {
    return isPaymentPaid(row);
  }
  if (tabIndex === 1) {
    return orderLabelPurchased(row);
  }
  if (tabIndex === 2) {
    return Boolean(row?.admin_fulfillment_print_done_at);
  }
  if (tabIndex === 3) {
    return Boolean(row?.admin_fulfillment_summary_done_at);
  }
  if (tabIndex === 4) {
    return Boolean(row?.admin_handoff_at) || String(row?.order_status || "") === "shipped";
  }
  return false;
}

/** @returns {"default" | "error" | "cancelled"} */
export function fulfillmentVariantForRow(row) {
  if (isOrderCancelled(row)) {
    return "cancelled";
  }
  const syncFailed = String(row?.shippo_sync_status || "") === "error";
  const shipErr = String(row?.shippo_shipment_sync_error || "").trim();
  const labelErr = String(row?.shippo_label_sync_error || "").trim();
  const tx = String(row?.shippo_transaction_status || "").toUpperCase();
  if (syncFailed && !String(row?.shippo_order_id || "").trim()) {
    return "error";
  }
  if (shipErr || labelErr || tx === "ERROR") {
    return "error";
  }
  return "default";
}

export function fulfillmentBlockingIssue(row) {
  if (!isPaymentPaid(row)) {
    return null;
  }
  const syncFailed = String(row?.shippo_sync_status || "") === "error";
  if (syncFailed && !String(row?.shippo_order_id || "").trim()) {
    return String(row?.shippo_sync_error || "Shippo order sync failed.").trim() || "Shippo sync error.";
  }
  const shipErr = String(row?.shippo_shipment_sync_error || "").trim();
  const labelErr = String(row?.shippo_label_sync_error || "").trim();
  const tx = String(row?.shippo_transaction_status || "").toUpperCase();
  if (shipErr) {
    return shipErr;
  }
  if (tx === "ERROR" || labelErr) {
    return labelErr || "Label purchase failed.";
  }
  return null;
}

export function fulfillmentNextActionLabel(row) {
  if (isOrderCancelled(row)) {
    return "—";
  }
  if (!isPaymentPaid(row)) {
    return "Await payment";
  }
  const a = deriveActiveFulfillmentStepIndex(row);
  if (a === 1) {
    return orderLabelPurchased(row) ? "Continue" : "Set up label & buy";
  }
  if (a === 2) {
    return "Print / download";
  }
  if (a === 3) {
    return "Review summary";
  }
  if (a === 4) {
    return "Confirm handoff";
  }
  if (a >= 5) {
    return "Complete";
  }
  return "View order";
}

export function fulfillmentSummaryTitle(row) {
  if (isOrderCancelled(row)) {
    return "Cancelled";
  }
  if (!isPaymentPaid(row)) {
    return "Awaiting payment";
  }
  const a = deriveActiveFulfillmentStepIndex(row);
  if (a >= 5) {
    return "Shipped · complete";
  }
  if (a === 1 && !orderLabelPurchased(row)) {
    return "Label & shipping";
  }
  if (a === 2) {
    return "Print documents";
  }
  if (a === 3) {
    return "Summary";
  }
  if (a === 4) {
    return "Handoff confirmation";
  }
  return "Order review";
}
