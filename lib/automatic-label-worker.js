import { getOrderByIdForService } from "./orders.js";
import {
  claimOrderShippoLabelPackage,
  listOrderShippoLabels,
  setAutomaticLabelOrderStatus,
  transitionClaimedOrderShippoLabelPackage,
  reconcileOrderShippoLabelTransaction,
} from "./order-shippo-labels.js";
import { findRecentShippoTransactionForRate, purchaseShippoLabelWithRate } from "./shippo-transaction.js";

const MAX_AUTOMATIC_ATTEMPTS = 3;

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function isAutomaticShippoLabelEligible(order) {
  const source = String(order?.order_source || "").trim().toLowerCase();
  const type = String(order?.order_type || "").trim().toLowerCase();
  const fulfillment = String(order?.fulfillment_method || "carrier").trim().toLowerCase();
  return (
    source === "web" &&
    (!type || type === "online") &&
    String(order?.status || "").trim().toLowerCase() === "paid" &&
    order?.shippo_label_required !== false &&
    !["pickup", "local", "local_delivery", "b2b_shipping", "external"].includes(fulfillment)
  );
}

export function automaticLabelPackagePlan(order) {
  const selected = jsonObject(order?.selected_shipping_rate_snapshot_json);
  const parcelSummary = jsonObject(order?.quoted_parcel_summary_json);
  const rateIds = Array.isArray(selected.packageRateObjectIds)
    ? selected.packageRateObjectIds.map((value) => String(value || "").trim())
    : [];
  const shipmentIds = Array.isArray(selected.packageShipmentObjectIds)
    ? selected.packageShipmentObjectIds.map((value) => String(value || "").trim())
    : [];
  const parcels = Array.isArray(parcelSummary.parcels) ? parcelSummary.parcels : [];
  const count = Math.max(0, Math.floor(Number(parcelSummary.parcelCount) || parcels.length || rateIds.length));
  if (!count || rateIds.length !== count || rateIds.some((id) => !id)) {
    const error = new Error("The selected checkout service is missing a package rate.");
    error.code = "CHECKOUT_PACKAGE_RATE_MISSING";
    throw error;
  }
  return Array.from({ length: count }, (_, index) => ({
    index,
    count,
    rateObjectId: rateIds[index],
    shipmentObjectId: shipmentIds[index] || null,
    parcelMetadata: parcels[index] || null,
    carrier: selected.provider || null,
    serviceCode: selected.serviceCode || null,
    serviceLabel: selected.serviceLabel || null,
    amountCents: Number.isFinite(Number(selected.amountCents)) ? Math.round(Number(selected.amountCents)) : null,
    currency: String(selected.currency || "USD").toUpperCase(),
  }));
}

function purchasedRow(row) {
  return String(row?.status || "").toLowerCase() === "purchased" && Boolean(String(row?.label_url || "").trim());
}

function retryDelayMs(attemptCount) {
  return Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attemptCount - 1));
}

function transactionPatch(result, pkg) {
  const rawRate = result?.rate && typeof result.rate === "object" ? result.rate : {};
  const amount = Number.parseFloat(String(rawRate.amount ?? ""));
  return {
    transaction_id: result?.transactionObjectId || null,
    label_url: result?.labelUrl || null,
    tracking_number: result?.trackingNumber || null,
    tracking_url: result?.trackingUrlProvider || null,
    carrier: String(rawRate.provider || rawRate.provider_name || pkg.carrier || "").trim() || null,
    servicelevel_token: String(rawRate.servicelevel?.token || pkg.serviceCode || "").trim() || null,
    servicelevel_name: String(rawRate.servicelevel?.name || pkg.serviceLabel || "").trim() || null,
    amount_cents: Number.isFinite(amount) ? Math.round(amount * 100) : pkg.amountCents,
    currency: String(rawRate.currency || pkg.currency || "USD").toUpperCase(),
    error_message: null,
    last_error_code: null,
    next_retry_at: null,
  };
}

export async function processAutomaticLabelsForOrder(orderId, dependencies = {}) {
  const getOrder = dependencies.getOrder ?? getOrderByIdForService;
  const listLabels = dependencies.listLabels ?? listOrderShippoLabels;
  const claimPackage = dependencies.claimPackage ?? claimOrderShippoLabelPackage;
  const transitionPackage = dependencies.transitionPackage ?? transitionClaimedOrderShippoLabelPackage;
  const setOrderStatus = dependencies.setOrderStatus ?? setAutomaticLabelOrderStatus;
  const purchaseLabel = dependencies.purchaseLabel ?? purchaseShippoLabelWithRate;
  const findRecentTransaction = dependencies.findRecentTransaction ?? findRecentShippoTransactionForRate;
  const reconcileTransaction = dependencies.reconcileTransaction ?? reconcileOrderShippoLabelTransaction;
  const now = dependencies.now ?? (() => new Date());

  const order = await getOrder(orderId);
  if (!order || !isAutomaticShippoLabelEligible(order)) return { skipped: true, reason: "not_eligible" };
  let plan;
  try {
    plan = automaticLabelPackagePlan(order);
  } catch (error) {
    await setOrderStatus(orderId, "admin_review_required", error.code || "CHECKOUT_PACKAGE_RATE_MISSING");
    return { ok: false, reviewRequired: true, errorCode: error.code };
  }

  await setOrderStatus(orderId, "label_processing", "AUTOMATIC_LABEL_WORKER_STARTED");
  const existing = await listLabels(orderId);
  const byIndex = new Map(existing.map((row) => [Number(row.parcel_index), row]));
  const outcomes = [];

  for (const pkg of plan) {
    const prior = byIndex.get(pkg.index);
    if (purchasedRow(prior)) {
      outcomes.push({ index: pkg.index, status: "purchased", skipped: true });
      continue;
    }
    if (String(prior?.status || "") === "unknown") {
      const existingTransaction = await findRecentTransaction(pkg.rateObjectId);
      if (existingTransaction) {
        const attached = await reconcileTransaction(prior, existingTransaction);
        outcomes.push({ index: pkg.index, status: attached ? "purchased" : "unknown", reconciled: Boolean(attached) });
      } else {
        outcomes.push({ index: pkg.index, status: "unknown", skipped: true });
      }
      continue;
    }
    if (String(prior?.status || "") === "admin_review_required") {
      outcomes.push({ index: pkg.index, status: String(prior.status), skipped: true });
      continue;
    }
    const claim = await claimPackage({
      orderId,
      parcelIndex: pkg.index,
      parcelCount: pkg.count,
      rateObjectId: pkg.rateObjectId,
      shipmentObjectId: pkg.shipmentObjectId,
      parcelMetadata: pkg.parcelMetadata,
    });
    if (!claim) {
      outcomes.push({ index: pkg.index, status: "claimed_elsewhere", skipped: true });
      continue;
    }
    try {
      const result = await purchaseLabel(pkg.rateObjectId, { timeoutMs: 20_000 });
      const saved = await transitionPackage({
        orderId,
        parcelIndex: pkg.index,
        claimId: claim.claimId,
        status: "purchased",
        patch: transactionPatch(result, pkg),
      });
      if (!saved) throw Object.assign(new Error("Label save lost its package claim."), { code: "LABEL_SAVE_CLAIM_LOST" });
      outcomes.push({ index: pkg.index, status: "purchased" });
    } catch (error) {
      const attempts = Math.max(1, Number(claim.row?.attempt_count) || 1);
      const unknown = error?.labelPurchaseOutcomeUnknown === true || error?.code === "LABEL_SAVE_CLAIM_LOST";
      const exhausted = !unknown && attempts >= MAX_AUTOMATIC_ATTEMPTS;
      const status = unknown ? "unknown" : exhausted ? "admin_review_required" : "retry";
      await transitionPackage({
        orderId,
        parcelIndex: pkg.index,
        claimId: claim.claimId,
        status,
        patch: {
          error_message: String(error?.message || "Label purchase failed.").slice(0, 500),
          last_error_code: unknown
            ? "SHIPPO_LABEL_OUTCOME_UNKNOWN"
            : exhausted
              ? "LABEL_RETRY_EXHAUSTED"
              : "SHIPPO_LABEL_PURCHASE_FAILED",
          next_retry_at: status === "retry" ? new Date(now().getTime() + retryDelayMs(attempts)).toISOString() : null,
        },
      });
      outcomes.push({ index: pkg.index, status });
    }
  }

  const finalRows = await listLabels(orderId);
  const purchased = finalRows.filter(purchasedRow).length;
  const allPurchased = purchased === plan.length;
  const hasUnknown = finalRows.some((row) => String(row.status) === "unknown");
  const hasReview = finalRows.some((row) => String(row.status) === "admin_review_required");
  const hasRetry = finalRows.some((row) => String(row.status) === "retry");
  const nextStatus = allPurchased
    ? "ready_to_fulfill"
    : hasReview
      ? "admin_review_required"
      : hasUnknown
        ? "label_purchase_unknown"
        : purchased > 0
          ? "partial_label_failure"
          : hasRetry
            ? "paid_label_retry"
            : "label_processing";
  await setOrderStatus(orderId, allPurchased ? "labels_purchased" : nextStatus, "AUTOMATIC_LABEL_PACKAGE_SUMMARY");
  if (allPurchased) await setOrderStatus(orderId, "ready_to_fulfill", "ALL_PACKAGE_LABELS_PURCHASED");
  return { ok: allPurchased, purchased, parcelCount: plan.length, orderStatus: nextStatus, outcomes };
}
