import { getOrderByIdForService, updateOrderShippoShipmentState } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { syncWebsiteOrderToShippo } from "../lib/shippo-order-sync.js";
import { resolveParcelsForFulfillment } from "../lib/shippo-order-parcels.js";
import {
  buildShippoSingleParcelShipmentCreateBody,
  createShippoShipmentForWebsiteOrder,
  postShippoShipmentCreate,
} from "../lib/shippo-shipment-sync.js";
import { sortRatesForAdminDisplay } from "../lib/shippo-rate-utils.js";
import { aggregateShippoPackageRates } from "../lib/shippo-package-rate-set.js";
import { recordShippingHealthEvent } from "../lib/shipping-health.js";
import { warehouseAddressFingerprint, withRuntimeWarehouseAddress } from "../lib/warehouse-settings.js";

function adminShippoErrorMessage(error) {
  const code = String(error?.code || "").trim();
  if (code === "SHIPPO_SHIPMENT_TIMEOUT") {
    return "Shippo did not respond in time. The original checkout quote is still saved; try refreshing current label rates again.";
  }
  if (code === "SHIPPO_SHIPMENT_FETCH_FAILED") {
    return "Could not reach Shippo. The original checkout quote is still saved; try refreshing current label rates again or use an external label.";
  }
  const msg = String(error?.message || "").trim();
  if (/fetch failed/i.test(msg)) {
    return "Could not reach Shippo. The original checkout quote is still saved; try refreshing current label rates again or use an external label.";
  }
  return msg || "Shippo shipment could not be created or refreshed.";
}

function storedRateCount(raw) {
  let value = raw;
  if (typeof value === "string" && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return 0;
    }
  }
  if (Array.isArray(value)) return value.length;
  return Array.isArray(value?.rates) ? value.rates.length : 0;
}

export function packageRateStatePatch(packageRateSet, previousRatesPayload) {
  const rates = Array.isArray(packageRateSet?.rateSet) ? packageRateSet.rateSet : [];
  if (rates.length) {
    return {
      shippo_shipment_rates_json: {
        rates,
        rateCount: rates.length,
        labelRateMode: "per_package_sum",
        packageShipments: packageRateSet.shipments,
        shipFromFingerprint: packageRateSet.shipFromFingerprint || null,
      },
      shippo_shipment_rate_status: "rates_available",
      shippo_shipment_sync_error: null,
    };
  }
  if (storedRateCount(previousRatesPayload) > 0) {
    return {
      shippo_shipment_rate_status: "refresh_failed",
      shippo_shipment_sync_error: packageRateSet?.error || "Shippo returned no current package rates.",
    };
  }
  return {
    shippo_shipment_rates_json: {
      rates: [],
      rateCount: 0,
      labelRateMode: "per_package_sum",
      packageShipments: packageRateSet?.shipments || [],
    },
    shippo_shipment_rate_status: "no_rates",
    shippo_shipment_sync_error: packageRateSet?.error || "Shippo returned no current package rates.",
  };
}

async function createSingleParcelShipment(order, parcel, index, parcelCount) {
  const built = buildShippoSingleParcelShipmentCreateBody(order, parcel, index, parcelCount);
  if (!built.ok) {
    return { ok: false, rates: [], error: "Invalid package or ship-from address." };
  }
  return postShippoShipmentCreate(built.body);
}

async function buildPackageLabelRateSet(order) {
  order = await withRuntimeWarehouseAddress(order);
  const plan = resolveParcelsForFulfillment(order);
  const parcels = Array.isArray(plan?.parcels) ? plan.parcels : [];
  if (parcels.length <= 1) {
    return null;
  }
  const packageRateLists = [];
  const shipments = [];
  for (let index = 0; index < parcels.length; index += 1) {
    const shipment = await createSingleParcelShipment(order, parcels[index], index, parcels.length);
    shipments.push({
      package: index + 1,
      shipmentId: shipment?.shipmentId || null,
      rateCount: Array.isArray(shipment?.rates) ? shipment.rates.length : 0,
      ok: shipment?.ok === true,
      error: shipment?.errorMessage || shipment?.error || null,
    });
    if (!shipment?.ok || !Array.isArray(shipment.rates) || !shipment.rates.length) {
      return {
        ok: false,
        error: `Shippo returned no label rates for package ${index + 1}. Try refreshing current rates again.`,
        rateSet: [],
        shipments,
        parcelCount: parcels.length,
        plan,
      };
    }
    packageRateLists.push(shipment.rates);
  }
  const rateSet = aggregateShippoPackageRates(packageRateLists);

  return {
    ok: Boolean(rateSet.length),
    error: rateSet.length ? null : "Shippo returned no services available for every package. Try refreshing current rates again.",
    rateSet: sortRatesForAdminDisplay(rateSet),
    shipments,
    parcelCount: parcels.length,
    plan,
    shipFromFingerprint: warehouseAddressFingerprint(order.shippo_from_address_override_json),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const startedAt = Date.now();
  let healthOrderId = null;
  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    healthOrderId = order?.id || orderId;
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (String(order.status || "").toLowerCase() !== "paid") {
      res.status(400).json({ error: "Only paid orders can be synced to Shippo." });
      return;
    }

    const result = await syncWebsiteOrderToShippo(order.id, { skipAutoShipment: true });
    let refreshed = await getOrderByIdForService(order.id);

    if (!result.ok && !result.skipped) {
      res.status(502).json({
        error: result.error || "Shippo sync failed.",
        order: refreshed,
        shippo_last_error_response: refreshed?.shippo_last_error_response ?? null,
        shippo_last_attempt_payload: refreshed?.shippo_last_attempt_payload ?? null,
      });
      return;
    }

    if (!refreshed?.shippo_order_id) {
      res.status(502).json({
        error: "Shippo Order was not created; cannot build shipment.",
        order: refreshed,
        sync: result,
      });
      return;
    }

    let shipment = null;
    try {
      const previousRatesPayload = refreshed.shippo_shipment_rates_json;
      shipment = await createShippoShipmentForWebsiteOrder(refreshed, { force: true });
      const packageRateSet = await buildPackageLabelRateSet(refreshed);
      if (packageRateSet) {
        await updateOrderShippoShipmentState(refreshed.id, packageRateStatePatch(packageRateSet, previousRatesPayload));
        shipment = {
          ...shipment,
          rateCount: packageRateSet.rateSet.length,
          labelRateMode: "per_package_sum",
          packageRateSet,
        };
      }
    } catch (e) {
      console.error("[admin] Shippo shipment refresh after sync", e);
      refreshed = await getOrderByIdForService(order.id);
      const message = adminShippoErrorMessage(e);
      res.status(502).json({
        error: message,
        order: refreshed,
        sync: result,
        shipment: {
          ok: false,
          error: message,
          code: e?.code || null,
          technicalError: e?.technicalMessage || String(e?.message || e),
        },
      });
      return;
    }

    refreshed = await getOrderByIdForService(order.id);
    if (Number(shipment?.rateCount || 0) < 1) {
      await recordShippingHealthEvent({
        eventType: "admin_rate",
        outcome: "no_rates",
        errorCode: "SHIPPO_NO_RATES",
        orderId: healthOrderId,
        parcelCount: shipment?.packageRateSet?.parcelCount,
        rateCount: 0,
        durationMs: Date.now() - startedAt,
      });
      res.status(502).json({
        error: "Shippo returned no current label rates. Try Get current rates again.",
        order: refreshed,
        sync: result,
        shipment,
      });
      return;
    }
    await recordShippingHealthEvent({
      eventType: "admin_rate",
      outcome: "success",
      orderId: healthOrderId,
      parcelCount: shipment?.packageRateSet?.parcelCount || 1,
      rateCount: shipment?.rateCount,
      durationMs: Date.now() - startedAt,
    });
    res.status(200).json({
      ok: true,
      ...result,
      shipment,
      order: refreshed,
    });
  } catch (error) {
    console.error(error);
    await recordShippingHealthEvent({
      eventType: "admin_rate",
      outcome: error?.code === "SHIPPO_NO_RATES" ? "no_rates" : "failed",
      errorCode: error?.code || "UNKNOWN",
      orderId: healthOrderId,
      durationMs: Date.now() - startedAt,
    });
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not sync order to Shippo.",
    });
  }
}
