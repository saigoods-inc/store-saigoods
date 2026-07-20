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

/* ---------------------------------------------------------------------------
 * Order-type + derived-stage helpers.
 *
 * These were previously private to public/js/admin-orders.js (the old dashboard).
 * They are pure functions with no DOM/side effects, centralized here so admin-v2
 * pages (Orders) can import a single canonical computeFulfillmentWorkflow instead
 * of duplicating it. The old dashboard keeps its own local copies unchanged; this
 * is purely additive and does not alter any existing export or behavior.
 * ------------------------------------------------------------------------- */

export function isWalkInOrder(row) {
  return String(row?.order_type || "") === "walk_in" || String(row?.order_source || "") === "walk_in";
}

export function isManualOrder(row) {
  return String(row?.order_source || "") === "manual" || String(row?.order_type || "") === "manual";
}

export function isOnlineOrder(row) {
  return !isWalkInOrder(row) && !isManualOrder(row);
}

export function isPaymentAwaiting(row) {
  return String(row?.status || "").toLowerCase() !== "paid";
}

function parseCustomerAddressText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  let line1 = lines[0] || "";
  let line2 = "";
  let cityLine = "";
  let country = "";
  if (lines.length >= 4) {
    line2 = lines[1] || "";
    cityLine = lines[2] || "";
    country = lines[3] || "";
  } else if (lines.length === 3) {
    cityLine = lines[1] || "";
    country = lines[2] || "";
  } else if (lines.length === 2) {
    cityLine = lines[1] || "";
  }
  const m1 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s*,\s*(\d{5}(?:-\d{4})?)$/);
  const m2 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const m = m1 || m2;
  return {
    line1,
    line2,
    city: m ? String(m[1] || "").trim() : "",
    state: m ? String(m[2] || "").trim().toUpperCase().slice(0, 2) : "",
    postalCode: m ? String(m[3] || "").trim() : "",
    country: String(country || "").trim().toUpperCase(),
  };
}

function parseShippingAddressColumn(row) {
  const v = row?.shipping_address;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v;
  }
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

export function normalizeSavedShippingAddress(row) {
  const raw = parseShippingAddressColumn(row);
  const textFallback = parseCustomerAddressText(row?.customer_address);
  const name = String(raw.name || raw.full_name || "").trim() || String(row?.customer_name || "").trim();
  const email = String(raw.email || "").trim() || String(row?.customer_email || "").trim();
  const phone = String(raw.phone || "").trim() || String(row?.customer_phone || "").trim();
  const line1 = String(raw.line1 || raw.street1 || raw.address_line_1 || "").trim() || String(textFallback?.line1 || "").trim();
  const line2 = String(raw.line2 || raw.street2 || raw.address_line_2 || "").trim() || String(textFallback?.line2 || "").trim();
  const city = String(raw.city || raw.locality || "").trim() || String(textFallback?.city || "").trim();
  const state =
    String(raw.state || raw.province || raw.region || raw.administrative_district_level_1 || "")
      .trim()
      .toUpperCase()
      .slice(0, 2) || String(textFallback?.state || "").trim().toUpperCase().slice(0, 2);
  const postalCode =
    String(raw.postalCode || raw.zip || raw.zip_code || raw.postal_code || "").trim() || String(textFallback?.postalCode || "").trim();
  const country = String(raw.country || raw.country_code || "").trim().toUpperCase() || String(textFallback?.country || "").trim().toUpperCase();
  return { name, email, phone, line1, line2, city, state, postalCode, country };
}

export function missingShippoAddressFields(row) {
  const addr = normalizeSavedShippingAddress(row);
  const missing = [];
  if (!addr.name) missing.push("shipping name");
  if (!addr.line1) missing.push("shipping street");
  if (!addr.city) missing.push("city");
  if (!addr.state) missing.push("state");
  if (!addr.postalCode) missing.push("ZIP");
  if (!addr.country) missing.push("country");
  return { addr, missing };
}

function isTrackingDelivered(row) {
  return String(row?.shippo_tracking_status || "").toUpperCase() === "DELIVERED";
}

function isTrackingInTransit(row) {
  const t = String(row?.shippo_tracking_status || "").toUpperCase();
  if (!t || t === "UNKNOWN" || t === "PRE_TRANSIT" || t === "DELIVERED") {
    return false;
  }
  if (["TRANSIT", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(t)) {
    return true;
  }
  return t.includes("TRANSIT");
}

/**
 * Single derived workflow for table, detail, and filters. Copied verbatim from the
 * old /admin Orders page (external fulfillment model; legacy Shippo data ignored for
 * stage labels). Pure function.
 * @returns {{ key: string, label: string, nextAction: string, activeStepIndex: number, blockingIssue: string | null, variant: "default" | "error" | "cancelled" }}
 */
export function computeFulfillmentWorkflow(row) {
  const base = (patch) => ({
    key: "unknown",
    label: "Unknown",
    nextAction: "View details",
    activeStepIndex: 0,
    blockingIssue: null,
    variant: "default",
    ...patch,
  });

  const os = String(row?.order_status || "");
  if (os === "cancelled") {
    return base({ key: "cancelled", label: "Cancelled", nextAction: "—", activeStepIndex: -1, variant: "cancelled" });
  }

  if (isWalkInOrder(row) && os === "draft") {
    return base({ key: "walk_in_draft", label: "Walk-in draft (unpaid)", nextAction: "Complete walk-in", activeStepIndex: 0 });
  }
  if (String(row?.order_source) === "manual" && os === "draft") {
    const isPayLater = String(row?.payment_flow || "") === "pay_later";
    return base({
      key: isPayLater ? "manual_pay_later" : "manual_draft",
      label: isPayLater ? "Pay later (unpaid)" : "Manual draft",
      nextAction: isPayLater ? "Record payment when received" : "Email payment link",
      activeStepIndex: 0,
    });
  }
  if (String(row?.order_source) === "manual" && os === "payment_link_sent") {
    return base({ key: "payment_link_sent", label: "Payment link sent", nextAction: "Await payment", activeStepIndex: 0 });
  }

  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  if (!paymentPaid) {
    return base({ key: "awaiting_payment", label: "Awaiting payment", nextAction: "Await payment", activeStepIndex: 0 });
  }

  if (row?.shippo_label_required === false) {
    return base({ key: "no_carrier_label", label: "Paid · pickup or local", nextAction: "Hand off or deliver — no Shippo label", activeStepIndex: 0 });
  }

  const missing = missingShippoAddressFields(row).missing;
  if (missing.length > 0) {
    return base({
      key: "address_required",
      label: "Paid · ship-to incomplete",
      nextAction: "Complete ship-to in details",
      activeStepIndex: 0,
      blockingIssue: `Missing: ${missing.join(", ")}`,
      variant: "error",
    });
  }

  if (os === "partial_label_purchase") {
    return base({
      key: "partial_shippo_labels",
      label: "Paid · partial Shippo labels",
      nextAction: "Open order details and finish failed packages",
      activeStepIndex: 0,
      variant: "error",
      blockingIssue: "Not all per-package Shippo labels were purchased. Use Retry on failed rows or Buy all labels again (skips already purchased).",
    });
  }

  if (isOrderShipped(row)) {
    if (isTrackingDelivered(row)) {
      return base({ key: "delivered", label: "Delivered", nextAction: "—", activeStepIndex: 1 });
    }
    if (isTrackingInTransit(row)) {
      return base({ key: "in_transit", label: "In transit", nextAction: "Track package", activeStepIndex: 1 });
    }
    return base({ key: "shipped", label: "Shipped", nextAction: "—", activeStepIndex: 1 });
  }

  if (!manualFulfillmentRecordComplete(row)) {
    return base({ key: "need_label_records", label: "Paid · record shipment", nextAction: "", activeStepIndex: 0 });
  }

  return base({
    key: "ready_mark_shipped",
    label: "Ready to mark shipped",
    nextAction: "Confirm shipped",
    activeStepIndex: 1,
    blockingIssue: fulfillmentBlockingIssue(row),
    variant: fulfillmentVariantForRow(row),
  });
}
