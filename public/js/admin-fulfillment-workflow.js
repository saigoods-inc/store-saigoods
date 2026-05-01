/**
 * Admin fulfillment: two visible steps (details + shipped). External label APIs remain on the server.
 */

export const FULFILLMENT_STEP_LABELS = ["Order created & paid", "Shipped"];

/** Legacy Shippo-purchased label (still shown in technical details when present). */
export function orderLabelPurchased(row) {
  return (
    Boolean(String(row?.shippo_label_url || "").trim()) &&
    String(row?.shippo_transaction_status || "").toUpperCase() === "SUCCESS"
  );
}

function externalTrackingLinesFromRow(row) {
  const s = String(row?.admin_external_tracking_number || "").trim();
  if (!s) {
    return [];
  }
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function hasUploadedLabelFiles(row) {
  return String(row?.admin_external_label_storage_path || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length > 0;
}

export function manualFulfillmentRecordComplete(row) {
  return (
    Boolean(String(row?.admin_external_carrier || "").trim()) &&
    externalTrackingLinesFromRow(row).length > 0 &&
    hasUploadedLabelFiles(row)
  );
}

export function isOrderCancelled(row) {
  return String(row?.order_status || "") === "cancelled";
}

export function isPaymentPaid(row) {
  return String(row?.status || "").toLowerCase() === "paid";
}

export function isOrderShipped(row) {
  return String(row?.order_status || "") === "shipped" || Boolean(row?.admin_handoff_at);
}

/** @returns {number} 0–1 active step hint for tab UI; -1 unpaid/cancelled */
export function deriveActiveFulfillmentStepIndex(row) {
  if (!row || isOrderCancelled(row)) {
    return -1;
  }
  if (!isPaymentPaid(row)) {
    return -1;
  }
  if (isOrderShipped(row)) {
    return 1;
  }
  return 0;
}

export function canNavigateToFulfillmentTab(row, tabIndex) {
  if (tabIndex < 0 || tabIndex > 1) {
    return false;
  }
  if (!isPaymentPaid(row) || isOrderCancelled(row)) {
    return tabIndex === 0;
  }
  return true;
}

/** All paid-order tabs allow interaction (no “only active step” lock). */
export function canEditFulfillmentTab(row, tabIndex) {
  if (!isPaymentPaid(row) || isOrderCancelled(row)) {
    return false;
  }
  if (isOrderShipped(row)) {
    return tabIndex !== 1;
  }
  return tabIndex >= 0 && tabIndex <= 1;
}

export function fulfillmentTabDone(row, tabIndex) {
  if (tabIndex === 0) {
    return isPaymentPaid(row);
  }
  if (tabIndex === 1) {
    return isOrderShipped(row);
  }
  return false;
}

/** @returns {"default" | "error" | "cancelled"} */
export function fulfillmentVariantForRow(row) {
  if (isOrderCancelled(row)) {
    return "cancelled";
  }
  return "default";
}

export function fulfillmentBlockingIssue(row) {
  if (!isPaymentPaid(row)) {
    return null;
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
  if (isOrderShipped(row)) {
    return "Complete";
  }
  const os = String(row?.order_status || "");
  if (os === "label_purchased" || os === "ready_to_ship") {
    return "Print label · Apply · Ship";
  }
  if (!manualFulfillmentRecordComplete(row)) {
    return "Open details";
  }
  return "Mark shipped";
}

export function fulfillmentSummaryTitle(row) {
  if (isOrderCancelled(row)) {
    return "Cancelled";
  }
  if (!isPaymentPaid(row)) {
    return "Awaiting payment";
  }
  if (isOrderShipped(row)) {
    return "Shipped";
  }
  const os = String(row?.order_status || "");
  if (os === "label_purchased") {
    return "Labels purchased";
  }
  if (!manualFulfillmentRecordComplete(row)) {
    return "Fulfillment";
  }
  return "Ready to ship";
}
