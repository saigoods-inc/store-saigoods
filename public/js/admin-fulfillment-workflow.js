/**
 * Admin fulfillment: external label purchase, platform-agnostic (3 steps).
 */

export const FULFILLMENT_STEP_LABELS = ["Order created & paid", "Label records", "Shipped"];

/** Legacy Shippo-purchased label (still shown in technical details when present). */
export function orderLabelPurchased(row) {
  return (
    Boolean(String(row?.shippo_label_url || "").trim()) &&
    String(row?.shippo_transaction_status || "").toUpperCase() === "SUCCESS"
  );
}

export function manualFulfillmentRecordComplete(row) {
  return (
    Boolean(String(row?.admin_external_carrier || "").trim()) &&
    Boolean(String(row?.admin_external_tracking_number || "").trim()) &&
    Boolean(String(row?.admin_external_label_storage_path || "").trim())
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

/** @returns {number} 0–2 active step hint for tab UI; -1 unpaid/cancelled */
export function deriveActiveFulfillmentStepIndex(row) {
  if (!row || isOrderCancelled(row)) {
    return -1;
  }
  if (!isPaymentPaid(row)) {
    return -1;
  }
  if (isOrderShipped(row)) {
    return 2;
  }
  if (!manualFulfillmentRecordComplete(row)) {
    return 1;
  }
  return 2;
}

export function canNavigateToFulfillmentTab(row, tabIndex) {
  if (tabIndex < 0 || tabIndex > 2) {
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
    return tabIndex !== 2;
  }
  return tabIndex >= 0 && tabIndex <= 2;
}

export function fulfillmentTabDone(row, tabIndex) {
  if (tabIndex === 0) {
    return isPaymentPaid(row);
  }
  if (tabIndex === 1) {
    return manualFulfillmentRecordComplete(row);
  }
  if (tabIndex === 2) {
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
  if (!manualFulfillmentRecordComplete(row)) {
    return "Record label & uploads";
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
  if (!manualFulfillmentRecordComplete(row)) {
    return "Label records";
  }
  return "Ready to ship";
}
