import { getOrderByIdForService, updateOrderShippoShipmentState } from "./orders.js";
import {
  claimOrderShippoLabelPurchase,
  listOrderShippoLabels,
  recomputeOrderStatusForMultiLabels,
  upsertOrderShippoLabelRow,
} from "./order-shippo-labels.js";
import { resolveParcelsForFulfillment } from "./shippo-order-parcels.js";
import { buildShippoSingleParcelShipmentCreateBody, postShippoShipmentCreate } from "./shippo-shipment-sync.js";
import { selectLabelPurchaseRateMatching } from "./shippo-label-rate-pick.js";
import { purchaseShippoLabelWithRate } from "./shippo-transaction.js";

export function isAutomaticManualLabelEligible(order) {
  return (
    String(order?.order_source || "").toLowerCase() === "manual" &&
    String(order?.status || "").toLowerCase() === "paid" &&
    String(order?.payment_flow || "").toLowerCase() === "square_payment_link" &&
    String(order?.fulfillment_method || "carrier").toLowerCase() === "carrier" &&
    order?.shippo_label_required !== false
  );
}

function desiredService(order) {
  const desired = {
    provider: String(order?.quoted_shipping_provider || "").trim(),
    servicelevelName: String(order?.quoted_shipping_service_label || "").trim(),
    servicelevelToken: String(order?.quoted_shipping_service_code || "").trim(),
  };
  return desired.provider && (desired.servicelevelName || desired.servicelevelToken) ? desired : null;
}

function rateMeta(rate) {
  const amount = Number.parseFloat(String(rate?.amount ?? ""));
  return {
    amountCents: Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0,
    currency: String(rate?.currency || "USD").toUpperCase(),
    carrier: String(rate?.provider || rate?.provider_name || "").trim() || null,
    serviceName: String(rate?.servicelevel?.name || rate?.servicelevel_name || "").trim() || null,
    serviceToken: String(rate?.servicelevel?.token || rate?.servicelevel_token || "").trim() || null,
  };
}

function purchased(row) {
  return String(row?.status || "").toLowerCase() === "purchased" && Boolean(String(row?.label_url || "").trim());
}

function allowedOverageCents() {
  const value = Math.round(Number(process.env.AUTO_LABEL_MAX_OVERAGE_CENTS || "0"));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedIds(value) {
  return Array.isArray(value) ? value.map((id) => String(id || "").trim()).filter(Boolean) : [];
}

/** Recover the exact Shippo Rate IDs selected while the admin created the order. */
export function originalShippoRatePlan(order, parcelCount) {
  const count = Math.max(0, Math.floor(Number(parcelCount) || 0));
  if (!count) return null;
  const selected = parseObject(order?.selected_shipping_rate_snapshot_json);
  const quote = parseObject(order?.checkout_quote_snapshot_json);
  const quoteShipping = parseObject(quote?.shipping);
  let rateIds = normalizedIds(
    selected.packageRateObjectIds ||
      selected.selectedPackageRateObjectIds ||
      quoteShipping.selectedPackageRateObjectIds,
  );
  let shipmentIds = normalizedIds(
    selected.packageShipmentObjectIds ||
      selected.selectedPackageShipmentObjectIds ||
      quoteShipping.selectedPackageShipmentObjectIds,
  );
  const aggregateId = String(
    selected.providerQuoteId || order?.quoted_shipping_provider_quote_id || "",
  ).trim();
  if (!rateIds.length && count === 1 && aggregateId && !aggregateId.startsWith("package-set:")) {
    rateIds = [aggregateId];
  }
  if (rateIds.length !== count) return null;
  if (shipmentIds.length !== count) shipmentIds = Array(count).fill(null);
  const quotedCostCents = Math.max(
    0,
    Number(order?.quoted_shipping_base_amount_cents) ||
      Number(selected.amountCents) ||
      Number(order?.quoted_shipping_amount_cents) ||
      0,
  );
  if (!quotedCostCents) return null;
  return { rateIds, shipmentIds, quotedCostCents };
}

export async function processAutomaticManualLabels(orderId, dependencies = {}) {
  const getOrder = dependencies.getOrder || getOrderByIdForService;
  const listLabels = dependencies.listLabels || listOrderShippoLabels;
  const resolveParcels = dependencies.resolveParcels || resolveParcelsForFulfillment;
  const buildShipment = dependencies.buildShipment || buildShippoSingleParcelShipmentCreateBody;
  const createShipment = dependencies.createShipment || postShippoShipmentCreate;
  const selectRate = dependencies.selectRate || selectLabelPurchaseRateMatching;
  const buyLabel = dependencies.buyLabel || purchaseShippoLabelWithRate;
  const claimLabel = dependencies.claimLabel || claimOrderShippoLabelPurchase;
  const saveLabel = dependencies.saveLabel || upsertOrderShippoLabelRow;
  const updateOrder = dependencies.updateOrder || updateOrderShippoShipmentState;
  const recomputeStatus = dependencies.recomputeStatus || recomputeOrderStatusForMultiLabels;

  const order = await getOrder(orderId);
  if (!order || !isAutomaticManualLabelEligible(order)) return { skipped: true, reason: "not_eligible" };
  const desired = desiredService(order);
  if (!desired) {
    await updateOrder(order.id, { shippo_label_sync_error: "Automatic label paused: the selected carrier service was not saved." });
    return { ok: false, reviewRequired: true, reason: "selected_service_missing" };
  }
  const plan = resolveParcels(order);
  const parcels = Array.isArray(plan?.parcels) ? plan.parcels : [];
  if (!parcels.length) {
    await updateOrder(order.id, { shippo_label_sync_error: "Automatic label paused: no package plan is available." });
    return { ok: false, reviewRequired: true, reason: "parcel_plan_missing" };
  }
  const existing = await listLabels(order.id);
  const byIndex = new Map(existing.map((row) => [Number(row.parcel_index), row]));
  if (parcels.every((_, index) => purchased(byIndex.get(index)))) {
    return { ok: true, skipped: true, reason: "already_purchased", parcelCount: parcels.length };
  }
  const blocked = parcels
    .map((_, index) => byIndex.get(index))
    .find((row) => row && !purchased(row));
  if (blocked) {
    const processing = String(blocked.status || "").toLowerCase() === "processing";
    if (!processing) {
      await updateOrder(order.id, {
        shippo_label_sync_error: "Automatic label purchase needs admin review before it can continue.",
      });
    }
    return {
      ok: false,
      skipped: processing,
      reviewRequired: !processing,
      reason: processing ? "already_processing" : "existing_label_attempt_requires_review",
    };
  }

  // Prefer the exact Shippo Rate IDs selected during admin order creation. This
  // avoids a second carrier rate request after payment. Older orders without saved
  // per-package IDs retain the fresh-rating path below.
  const prepared = [];
  const originalRates = originalShippoRatePlan(order, parcels.length);
  try {
    for (let index = 0; index < parcels.length; index += 1) {
      if (purchased(byIndex.get(index))) continue;
      if (originalRates) {
        prepared.push({
          index,
          parcel: parcels[index],
          shipment: { shipmentId: originalRates.shipmentIds[index] || null },
          rate: {
            object_id: originalRates.rateIds[index],
            provider: desired.provider,
            currency: String(order?.quoted_shipping_currency || "USD").toUpperCase(),
            servicelevel: {
              name: desired.servicelevelName || null,
              token: desired.servicelevelToken || null,
            },
          },
          meta: {
            amountCents: 0,
            currency: String(order?.quoted_shipping_currency || "USD").toUpperCase(),
            carrier: desired.provider,
            serviceName: desired.servicelevelName || null,
            serviceToken: desired.servicelevelToken || null,
          },
          originalRate: true,
        });
        continue;
      }
      const built = buildShipment(order, parcels[index], index, parcels.length);
      if (!built?.ok) throw Object.assign(new Error("Automatic label paused: a package or address is invalid."), { code: built?.reason || "shipment_invalid" });
      const shipment = await createShipment(built.body);
      if (!shipment?.ok) {
        throw Object.assign(new Error(shipment?.errorMessage || "Automatic label rating failed."), {
          code: shipment?.errorCode || "shipment_rate_failed",
          retryable: shipment?.retryable === true,
        });
      }
      const rate = selectRate(shipment.rates, desired);
      if (!rate) throw Object.assign(new Error(`Automatic label paused: ${desired.servicelevelName || desired.servicelevelToken} is no longer available.`), { code: "selected_service_unavailable" });
      prepared.push({ index, parcel: parcels[index], shipment, rate, meta: rateMeta(rate) });
    }
  } catch (error) {
    const reason = String(error?.code || "automatic_label_preflight_failed").slice(0, 64);
    const retryable = error?.retryable === true;
    await updateOrder(order.id, {
      shippo_label_sync_error: String(
        error?.message || (retryable ? "Automatic label purchase will retry shortly." : "Automatic label preparation needs admin review."),
      ).slice(0, 500),
    });
    return { ok: false, reviewRequired: !retryable, retryScheduled: retryable, reason };
  }
  const alreadySpent = existing.filter(purchased).reduce((sum, row) => sum + Math.max(0, Number(row.amount_cents) || 0), 0);
  const preparedCost = originalRates
    ? originalRates.quotedCostCents
    : prepared.reduce((sum, entry) => sum + entry.meta.amountCents, 0);
  const chargedShipping = Math.max(
    0,
    Number(order.paid_shipping_amount_cents) ||
      Number(order.shipping_cents) ||
      Number(order.quoted_shipping_amount_cents) ||
      0,
  );
  if (alreadySpent + preparedCost > chargedShipping + allowedOverageCents()) {
    const message = `Automatic label paused: current label cost $${((alreadySpent + preparedCost) / 100).toFixed(2)} exceeds collected shipping $${(chargedShipping / 100).toFixed(2)}.`;
    await updateOrder(order.id, { shippo_label_sync_error: message });
    return { ok: false, reviewRequired: true, reason: "price_exceeds_collected_shipping" };
  }

  let firstPurchased = null;
  let anotherWorkerOwnsParcel = false;
  for (const entry of prepared) {
    const fresh = await listLabels(order.id);
    if (purchased(fresh.find((row) => Number(row.parcel_index) === entry.index))) continue;
    const rateId = String(entry.rate?.object_id || "").trim();
    const parcelMetadata = { ...entry.parcel, _parcelIndex: entry.index, _parcelCount: parcels.length, _planSource: plan.source || null };
    const claimed = await claimLabel(order.id, entry.index, parcels.length, {
      parcel_metadata: parcelMetadata,
      shipment_object_id: entry.shipment.shipmentId || null,
      selected_rate_object_id: rateId,
    });
    if (!claimed) {
      anotherWorkerOwnsParcel = true;
      continue;
    }
    try {
      const result = await buyLabel(rateId, { timeoutMs: 20_000 });
      const rawRate = result?.rate && typeof result.rate === "object" ? result.rate : entry.rate;
      const meta = rateMeta(rawRate);
      const row = await saveLabel(order.id, entry.index, parcels.length, {
        parcel_metadata: parcelMetadata,
        shipment_object_id: entry.shipment.shipmentId || null,
        selected_rate_object_id: rateId,
        transaction_id: result?.transactionObjectId || null,
        label_url: result?.labelUrl || null,
        tracking_number: result?.trackingNumber || null,
        tracking_url: result?.trackingUrlProvider || null,
        status: "purchased",
        error_message: null,
        carrier: meta.carrier || entry.meta.carrier,
        servicelevel_name: meta.serviceName || entry.meta.serviceName,
        servicelevel_token: meta.serviceToken || entry.meta.serviceToken,
        amount_cents: meta.amountCents || entry.meta.amountCents,
        currency: meta.currency || entry.meta.currency,
      });
      if (!firstPurchased) firstPurchased = row;
    } catch (error) {
      await saveLabel(order.id, entry.index, parcels.length, {
        status: "failed",
        error_message: String(error?.message || "Automatic label purchase failed.").slice(0, 500),
      });
      await recomputeStatus(order.id, parcels.length);
      await updateOrder(order.id, { shippo_label_sync_error: "Automatic label purchase needs admin review." });
      return { ok: false, reviewRequired: true, reason: "purchase_failed" };
    }
  }

  await recomputeStatus(order.id, parcels.length);
  const finalRows = await listLabels(order.id);
  const complete = parcels.every((_, index) => purchased(finalRows.find((row) => Number(row.parcel_index) === index)));
  if (complete) {
    const first = firstPurchased || finalRows.find(purchased) || {};
    await updateOrder(order.id, {
      shippo_selected_rate_object_id: String(first.selected_rate_object_id || "").trim() || null,
      shippo_transaction_status: "SUCCESS",
      shippo_label_carrier: first.carrier || desired.provider,
      shippo_label_service: first.servicelevel_name || desired.servicelevelName,
      shippo_tracking_number: first.tracking_number || null,
      shippo_label_url: first.label_url || null,
      shippo_label_purchased_at: new Date().toISOString(),
      shippo_label_sync_error: null,
    });
  }
  return {
    ok: complete,
    skipped: !complete && anotherWorkerOwnsParcel,
    reason: !complete && anotherWorkerOwnsParcel ? "already_processing" : undefined,
    parcelCount: parcels.length,
    purchasedCount: finalRows.filter(purchased).length,
  };
}
