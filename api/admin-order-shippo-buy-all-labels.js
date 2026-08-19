import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { resolveParcelsForFulfillment } from "../lib/shippo-order-parcels.js";
import { getOrderByIdForService, updateOrderShippoShipmentState } from "../lib/orders.js";
import {
  buildShippoSingleParcelShipmentCreateBody,
  postShippoShipmentCreate,
} from "../lib/shippo-shipment-sync.js";
import { selectLabelPurchaseRateMatching } from "../lib/shippo-label-rate-pick.js";
import { purchaseShippoLabelWithRate } from "../lib/shippo-transaction.js";
import {
  listOrderShippoLabels,
  recomputeOrderStatusForMultiLabels,
  rowToLabelEntry,
  upsertOrderShippoLabelRow,
} from "../lib/order-shippo-labels.js";
import {
  releaseShippoLabelPurchaseClaim,
  tryClaimShippoLabelPurchase,
} from "../lib/shippo-label-purchase-claim.js";
import { recordShippingHealthEvent } from "../lib/shipping-health.js";
import { assertStoredRatesMatchWarehouse, withRuntimeWarehouseAddress } from "../lib/warehouse-settings.js";

const activePurchaseRequests = new Set();

/**
 * @param {object} rate
 * @returns {{ amountCents: number | null, currency: string | null, carrier: string, serviceName: string | null, token: string | null }}
 */
function rateToMeta(rate) {
  if (!rate || typeof rate !== "object") {
    return {
      amountCents: null,
      currency: null,
      carrier: null,
      serviceName: null,
      token: null,
    };
  }
  const amt = Number.parseFloat(String(rate.amount ?? ""));
  return {
    amountCents: Number.isFinite(amt) ? Math.round(amt * 100) : null,
    currency: (rate.currency && String(rate.currency).toUpperCase()) || "USD",
    carrier: String(rate.provider || rate.provider_name || "").trim() || null,
    serviceName: (rate.servicelevel && rate.servicelevel.name) || rate.servicelevel_name || null,
    token: (rate.servicelevel && rate.servicelevel.token) || rate.servicelevel_token || null,
  };
}

/**
 * @param {object} purchased from purchaseShippoLabelWithRate
 * @param {object} [fallbackRate] selected rate
 */
function mergeMetaFromTransaction(purchased, fallbackRate) {
  const r = purchased?.rate && typeof purchased.rate === "object" ? purchased.rate : null;
  const m = r ? rateToMeta(r) : rateToMeta(fallbackRate);
  return {
    carrier: m.carrier,
    servicelevel_name: m.serviceName,
    servicelevel_token: m.token,
    amount_cents: m.amountCents,
    currency: m.currency,
  };
}

/** Shippo transaction JSON: amount on tx or expanded rate (USD string → cents). */
function labelCostCentsFromTransaction(tx, fallbackRateMeta) {
  if (tx && typeof tx === "object") {
    const direct = Number.parseFloat(String(tx.amount ?? ""));
    if (Number.isFinite(direct) && direct >= 0) {
      return Math.round(direct * 100);
    }
    const rate = tx.rate;
    if (rate && typeof rate === "object") {
      const a = Number.parseFloat(String(rate.amount ?? ""));
      if (Number.isFinite(a) && a >= 0) {
        return Math.round(a * 100);
      }
    }
  }
  if (fallbackRateMeta?.amountCents != null && Number.isFinite(fallbackRateMeta.amountCents)) {
    return fallbackRateMeta.amountCents;
  }
  return null;
}

function toApiLabel(dbRow, result) {
  const b = rowToLabelEntry(dbRow) || {};
  if (result) {
    return { ...b, result };
  }
  return b;
}

function storedRatesFromOrder(order) {
  const raw = order?.shippo_shipment_rates_json;
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.rates)) {
    return raw.rates;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.rates)) return parsed.rates;
    } catch {
      return [];
    }
  }
  return [];
}

export function selectedStoredRateMeta(order, rateObjectId) {
  const selectedId = String(rateObjectId || "").trim();
  if (!selectedId) {
    return null;
  }
  const found = storedRatesFromOrder(order).find((rate) => String(rate?.object_id || rate?.id || "").trim() === selectedId);
  if (!found) {
    return null;
  }
  let payload = order?.shippo_shipment_rates_json;
  if (typeof payload === "string" && payload.trim()) {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const packageRateObjectIds = Array.isArray(found.package_rate_object_ids)
    ? found.package_rate_object_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const packageShipmentObjectIds = Array.isArray(payload?.packageShipments)
    ? [...payload.packageShipments]
        .sort((a, b) => Number(a?.package || 0) - Number(b?.package || 0))
        .map((entry) => String(entry?.shipmentId || "").trim())
    : [];
  return {
    provider: String(found.provider || found.provider_name || found.carrier || "").trim(),
    servicelevelName: String(found.servicelevel_name || found.service || found?.servicelevel?.name || "").trim(),
    servicelevelToken: String(found.servicelevel_token || found?.servicelevel?.token || "").trim(),
    packageRateObjectIds,
    packageShipmentObjectIds,
  };
}

export function multiLabelOrderSummaryPatch({ selectedRateObjectId, desiredRate, purchasedMeta, complete, failedCount }) {
  const failureMessage = failedCount ? `${failedCount} package label${failedCount === 1 ? "" : "s"} failed.` : null;
  return {
    shippo_selected_rate_object_id: selectedRateObjectId,
    shippo_transaction_status: complete ? "SUCCESS" : "PARTIAL",
    shippo_label_carrier: complete ? purchasedMeta.carrier || desiredRate.provider || null : null,
    shippo_label_service: complete ? purchasedMeta.servicelevel_name || desiredRate.servicelevelName || null : null,
    shippo_tracking_number: complete ? purchasedMeta.tracking_number || null : null,
    shippo_label_url: complete ? purchasedMeta.label_url || null : null,
    shippo_label_purchased_at: complete ? new Date().toISOString() : null,
    shippo_label_sync_error: failureMessage,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  let activeRequestKey = null;
  let orderIdForClaim = null;
  let databaseClaim = null;
  let healthOutcome = "failed";
  let healthErrorCode = "LABEL_PURCHASE_FAILED";
  let healthParcelCount = null;
  const startedAt = Date.now();
  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    activeRequestKey = `order:${orderId}`;
    if (activePurchaseRequests.has(activeRequestKey)) {
      res.status(409).json({ error: "A label purchase is already running for this order. Please wait for it to finish." });
      return;
    }
    activePurchaseRequests.add(activeRequestKey);
    orderIdForClaim = orderId;
    databaseClaim = await tryClaimShippoLabelPurchase({ orderId });
    if (!databaseClaim) {
      healthOutcome = "locked";
      healthErrorCode = "LABEL_PURCHASE_LOCKED";
      res.status(409).json({ error: "A label purchase is already running for this order. Please wait for it to finish." });
      return;
    }
    let selectedRateObjectId = String(req.body?.rateObjectId || "").trim();
    const onlyIndexRaw = req.body?.parcelIndex;
    const onlyIndex =
      onlyIndexRaw == null || onlyIndexRaw === ""
        ? null
        : (() => {
            const n = Number(onlyIndexRaw);
            return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
          })();

    let order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (String(order.status || "").toLowerCase() !== "paid") {
      res.status(400).json({ error: "Only paid orders can purchase labels." });
      return;
    }
    order = await withRuntimeWarehouseAddress(order);
    assertStoredRatesMatchWarehouse(order);
    const desiredRate = selectedStoredRateMeta(order, selectedRateObjectId);
    if (!desiredRate) {
      res.status(400).json({ error: "Choose a current Shippo rate before purchasing package labels." });
      return;
    }

    let plan;
    try {
      plan = resolveParcelsForFulfillment(order);
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e || "Could not build parcels for order.") });
      return;
    }
    const parcels = Array.isArray(plan?.parcels) ? plan.parcels : [];
    if (!parcels.length) {
      res.status(400).json({ error: "No parcelable items for this order." });
      return;
    }
    const parcelCount = parcels.length;
    healthParcelCount = parcelCount;
    const indices = [];
    if (onlyIndex != null) {
      if (onlyIndex >= parcelCount) {
        res.status(400).json({ error: "parcelIndex out of range for this order." });
        return;
      }
      indices.push(onlyIndex);
    } else {
      for (let i = 0; i < parcelCount; i++) {
        indices.push(i);
      }
    }

    const existingAll = await listOrderShippoLabels(order.id);
    const byIndex = new Map();
    for (const r of existingAll) {
      if (r.parcel_index != null) {
        byIndex.set(r.parcel_index, r);
      }
    }

    const labels = [];
    let purchasedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const i of indices) {
      const parcel = parcels[i];
      const ex = byIndex.get(i);
      if (ex && String(ex.status || "") === "purchased" && String(ex.label_url || "").trim()) {
        labels.push(toApiLabel(ex, "skipped"));
        skippedCount += 1;
        continue;
      }
      if (ex && ["unknown", "processing", "admin_review_required"].includes(String(ex.status || "").toLowerCase())) {
        const status = String(ex.status || "").toLowerCase();
        const msg =
          status === "unknown"
            ? "This package has an unknown Shippo result. Reconcile it before any retry."
            : status === "processing"
              ? "This package is already being processed by another worker."
              : "This package requires admin review before another purchase attempt.";
        labels.push(toApiLabel(ex, "skipped"));
        skippedCount += 1;
        failedCount += 1;
        if (!ex.error_message) {
          await upsertOrderShippoLabelRow(order.id, i, parcelCount, { error_message: msg });
        }
        continue;
      }

      const parcelMeta = {
        ...parcel,
        _parcelIndex: i,
        _parcelCount: parcelCount,
        _planSource: plan.source || null,
      };

      await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
        parcel_metadata: parcelMeta,
        status: "processing",
        error_message: null,
      });
      byIndex.set(i, { ...byIndex.get(i), status: "processing" });

      const storedPackageRateId = String(desiredRate.packageRateObjectIds?.[i] || "").trim();
      let shipRes = null;
      let rate = null;
      if (storedPackageRateId) {
        shipRes = {
          ok: true,
          shipmentId: String(desiredRate.packageShipmentObjectIds?.[i] || "").trim() || null,
        };
        rate = {
          object_id: storedPackageRateId,
          provider: desiredRate.provider,
          servicelevel: {
            name: desiredRate.servicelevelName,
            token: desiredRate.servicelevelToken,
          },
        };
      } else {
        const bodyBuilt = buildShippoSingleParcelShipmentCreateBody(order, parcel, i, parcelCount);
        if (!bodyBuilt.ok) {
          const msg =
            bodyBuilt.reason === "missing_from_address_env"
              ? "Set SHIPPO_FROM_* env or sender override for this order."
              : "Invalid parcel or addresses.";
          await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
            status: "failed",
            error_message: msg.slice(0, 2000),
          });
          failedCount += 1;
          const ref = await listOrderShippoLabels(order.id);
          const row = ref.find((r) => r.parcel_index === i);
          labels.push(toApiLabel(row, "failed"));
          continue;
        }

        shipRes = await postShippoShipmentCreate(bodyBuilt.body);
        if (!shipRes.ok) {
          const msg = shipRes.errorMessage || "Shippo shipment create failed.";
          await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
            status: "failed",
            error_message: msg.slice(0, 2000),
          });
          failedCount += 1;
          const ref = await listOrderShippoLabels(order.id);
          const row = ref.find((r) => r.parcel_index === i);
          labels.push(toApiLabel(row, "failed"));
          continue;
        }
        rate = selectLabelPurchaseRateMatching(shipRes.rates, desiredRate);
      }
      if (!rate) {
        const msg = `Shippo did not return ${desiredRate.servicelevelName || desiredRate.servicelevelToken || "the selected service"} for package ${i + 1}. Refresh rates and try again.`;
        await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
          shipment_object_id: shipRes.shipmentId || null,
          status: "failed",
          error_message: msg,
        });
        failedCount += 1;
        const ref = await listOrderShippoLabels(order.id);
        const row = ref.find((r) => r.parcel_index === i);
        labels.push(toApiLabel(row, "failed"));
        continue;
      }
      const rateId = String(rate.object_id || "").trim();
      const rMeta = rateToMeta(rate);

      let purchased;
      try {
        const fresh = await getOrderByIdForService(order.id);
        if (!fresh) {
          throw new Error("Order disappeared");
        }
        const rowForSkip = (await listOrderShippoLabels(fresh.id)).find((x) => x.parcel_index === i);
        if (rowForSkip && String(rowForSkip.status) === "purchased" && String(rowForSkip.label_url || "").trim()) {
          labels.push(toApiLabel(rowForSkip, "skipped"));
          skippedCount += 1;
          continue;
        }
        purchased = await purchaseShippoLabelWithRate(rateId, {});
      } catch (e) {
        const msg = String(e?.message || "Label purchase failed.").slice(0, 2000);
        await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
          shipment_object_id: shipRes.shipmentId || null,
          selected_rate_object_id: rateId,
          status: "failed",
          error_message: msg,
          carrier: rMeta.carrier,
          servicelevel_name: rMeta.serviceName,
          servicelevel_token: rMeta.token,
          amount_cents: rMeta.amountCents,
          currency: rMeta.currency,
        });
        failedCount += 1;
        const ref = await listOrderShippoLabels(order.id);
        const row = ref.find((r) => r.parcel_index === i);
        labels.push(toApiLabel(row, "failed"));
        continue;
      }

      const merge = mergeMetaFromTransaction(purchased, rate);
      const resolvedCostCents =
        labelCostCentsFromTransaction(purchased.raw, rMeta) ??
        (merge.amount_cents != null && Number.isFinite(merge.amount_cents) ? merge.amount_cents : null);
      await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
        shipment_object_id: shipRes.shipmentId || null,
        selected_rate_object_id: rateId,
        transaction_id: purchased.transactionObjectId || null,
        label_url: purchased.labelUrl || null,
        tracking_number: purchased.trackingNumber || null,
        tracking_url: purchased.trackingUrlProvider || null,
        status: "purchased",
        error_message: null,
        carrier: merge.carrier,
        servicelevel_name: merge.servicelevel_name,
        servicelevel_token: merge.servicelevel_token,
        amount_cents: resolvedCostCents,
        currency: merge.currency,
        parcel_metadata: parcelMeta,
      });
      purchasedCount += 1;
      const refL = await listOrderShippoLabels(order.id);
      const rowF = refL.find((r) => r.parcel_index === i);
      labels.push(toApiLabel(rowF, "purchased"));
    }

    const recompute = await recomputeOrderStatusForMultiLabels(order.id, parcelCount);
    const firstPurchased = labels.find((label) => String(label?.status || "").toLowerCase() === "purchased" || label?.result === "purchased");
    const purchasedMeta = firstPurchased || {};
    if (purchasedCount > 0 || skippedCount > 0) {
      await updateOrderShippoShipmentState(
        order.id,
        multiLabelOrderSummaryPatch({
          selectedRateObjectId,
          desiredRate,
          purchasedMeta,
          complete: recompute.orderStatus === "label_purchased",
          failedCount,
        }),
      );
    }
    const refreshed = await getOrderByIdForService(order.id);
    if (failedCount > 0) {
      healthOutcome = purchasedCount > 0 || skippedCount > 0 ? "partial" : "failed";
      healthErrorCode = purchasedCount > 0 || skippedCount > 0 ? "LABEL_PURCHASE_PARTIAL" : "LABEL_PURCHASE_FAILED";
      const firstFailure = labels.find((label) => String(label?.status || "").toLowerCase() === "failed" || label?.result === "failed");
      const message =
        String(firstFailure?.errorMessage || firstFailure?.error_message || "").trim() ||
        `${failedCount} package label${failedCount === 1 ? "" : "s"} failed. Refresh rates and try again.`;
      res.status(502).json({
        ok: false,
        error: message,
        purchasedCount,
        failedCount,
        skippedCount,
        labels,
        parcelCount,
        orderStatusUpdate: recompute,
        order: refreshed,
      });
      return;
    }
    healthOutcome = "success";
    healthErrorCode = null;
    res.status(200).json({
      ok: true,
      purchasedCount,
      failedCount,
      skippedCount,
      labels,
      parcelCount,
      orderStatusUpdate: recompute,
      order: refreshed,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not purchase multi-labels.",
    });
  } finally {
    if (databaseClaim?.claimId && orderIdForClaim) {
      try {
        await releaseShippoLabelPurchaseClaim({
          orderId: orderIdForClaim,
          claimId: databaseClaim.claimId,
          outcome: healthOutcome,
        });
      } catch (releaseError) {
        console.error("[shipping] could not release label purchase claim", releaseError);
      }
    }
    await recordShippingHealthEvent({
      eventType: "label_purchase",
      outcome: healthOutcome,
      errorCode: healthErrorCode,
      orderId: orderIdForClaim,
      parcelCount: healthParcelCount,
      durationMs: Date.now() - startedAt,
    });
    if (activeRequestKey) activePurchaseRequests.delete(activeRequestKey);
  }
}
