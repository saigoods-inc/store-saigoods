import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { buildParcelsForOrder } from "../lib/shippo-order-parcels.js";
import { getOrderByIdForService } from "../lib/orders.js";
import {
  buildShippoSingleParcelShipmentCreateBody,
  postShippoShipmentCreate,
} from "../lib/shippo-shipment-sync.js";
import { selectLabelPurchaseRate } from "../lib/shippo-label-rate-pick.js";
import { purchaseShippoLabelWithRate } from "../lib/shippo-transaction.js";
import {
  listOrderShippoLabels,
  recomputeOrderStatusForMultiLabels,
  rowToLabelEntry,
  upsertOrderShippoLabelRow,
} from "../lib/order-shippo-labels.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    const onlyIndexRaw = req.body?.parcelIndex;
    const onlyIndex =
      onlyIndexRaw == null || onlyIndexRaw === ""
        ? null
        : (() => {
            const n = Number(onlyIndexRaw);
            return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
          })();

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (String(order.status || "").toLowerCase() !== "paid") {
      res.status(400).json({ error: "Only paid orders can purchase labels." });
      return;
    }

    let plan;
    try {
      plan = buildParcelsForOrder(order);
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

      const parcelMeta = {
        ...parcel,
        _parcelIndex: i,
        _parcelCount: parcelCount,
      };

      await upsertOrderShippoLabelRow(order.id, i, parcelCount, {
        parcel_metadata: parcelMeta,
        status: "processing",
        error_message: null,
      });
      byIndex.set(i, { ...byIndex.get(i), status: "processing" });

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

      const shipRes = await postShippoShipmentCreate(bodyBuilt.body);
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

      const rate = selectLabelPurchaseRate(shipRes.rates);
      if (!rate) {
        const msg = "No Shippo rates returned for this package.";
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
    const refreshed = await getOrderByIdForService(order.id);
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
  }
}
