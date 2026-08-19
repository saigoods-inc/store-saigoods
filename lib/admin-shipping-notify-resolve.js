/**
 * Resolve carrier / tracking for admin buyer shipping notification.
 * Accepts legacy Shippo, complete order_shippo_labels, or complete external record.
 */

import { manualFulfillmentRecordComplete, externalTrackingLinesFromRow } from "./admin-external-fulfillment.js";
import {
  listOrderShippoLabels,
  orderShippoPackageLabelsComplete,
  expectedShippoPackageCount,
  isCompletePurchasedShippoLabelRow,
} from "./order-shippo-labels.js";

/**
 * @param {object|null|undefined} order
 */
export function legacyShippoNotifyProofOk(order) {
  return (
    Boolean(String(order?.shippo_label_url || "").trim()) &&
    String(order?.shippo_transaction_status || "").toUpperCase() === "SUCCESS" &&
    Boolean(String(order?.shippo_tracking_number || "").trim())
  );
}

/**
 * @typedef {{ number: string, url?: string, carrier?: string, service?: string, packageLabel?: string }} NotifyTrackingEntry
 * @typedef {{
 *   ok: boolean,
 *   error?: string,
 *   source?: 'legacy_shippo' | 'package_labels' | 'external',
 *   sourceLabel?: string,
 *   carrier?: string,
 *   service?: string,
 *   trackings: NotifyTrackingEntry[],
 * }} NotifyFulfillmentResolve
 */

/**
 * Pure resolve from an order row + optional package-label rows (no DB).
 * Prefers complete package labels (multi-tracking), then legacy Shippo, then external.
 * @param {object} order
 * @param {object[]} [labelRows]
 * @returns {NotifyFulfillmentResolve}
 */
export function resolveBuyerShippingNotifyFulfillment(order, labelRows = []) {
  const rows = Array.isArray(labelRows) ? labelRows : [];
  const packageOk = orderShippoPackageLabelsComplete(rows, { orderStatus: order?.order_status });
  if (packageOk) {
    const expected = expectedShippoPackageCount(rows);
    /** @type {Map<number, object>} */
    const byIndex = new Map();
    for (const r of rows) {
      if (r?.parcel_index == null) continue;
      const i = Number(r.parcel_index);
      if (!Number.isFinite(i) || i < 0 || i >= expected) continue;
      byIndex.set(i, r);
    }
    /** @type {NotifyTrackingEntry[]} */
    const trackings = [];
    const carriers = new Set();
    const services = new Set();
    for (let i = 0; i < expected; i++) {
      const lab = byIndex.get(i);
      if (!lab || !isCompletePurchasedShippoLabelRow(lab)) continue;
      const number = String(lab.tracking_number || "").trim();
      const url = String(lab.tracking_url || "").trim() || undefined;
      const carrier = String(lab.carrier || "").trim() || undefined;
      const service = String(lab.servicelevel_name || "").trim() || undefined;
      if (carrier) carriers.add(carrier);
      if (service) services.add(service);
      trackings.push({
        number,
        url,
        carrier,
        service,
        packageLabel: `Package ${i + 1} of ${expected}`,
      });
    }
    if (!trackings.length) {
      return {
        ok: false,
        error: "Tracking number is required before sending a buyer notification.",
        trackings: [],
      };
    }
    return {
      ok: true,
      source: "package_labels",
      sourceLabel: "Package labels",
      carrier: [...carriers].join(", ") || undefined,
      service: [...services].join(", ") || undefined,
      trackings,
    };
  }

  if (legacyShippoNotifyProofOk(order)) {
    const number = String(order.shippo_tracking_number || "").trim();
    const url = String(order.shippo_tracking_url_provider || "").trim() || undefined;
    const carrier = String(order.shippo_label_carrier || "").trim() || undefined;
    const service = String(order.shippo_label_service || "").trim() || undefined;
    return {
      ok: true,
      source: "legacy_shippo",
      sourceLabel: "Shippo",
      carrier,
      service,
      trackings: [{ number, url, carrier, service }],
    };
  }

  if (manualFulfillmentRecordComplete(order)) {
    const lines = externalTrackingLinesFromRow(order);
    if (!lines.length) {
      return {
        ok: false,
        error: "Tracking number is required before sending a buyer notification.",
        trackings: [],
      };
    }
    const carrier = String(order.admin_external_carrier || "").trim() || undefined;
    const service = String(order.admin_external_service || "").trim() || undefined;
    return {
      ok: true,
      source: "external",
      sourceLabel: "External",
      carrier,
      service,
      trackings: lines.map((number) => ({ number, carrier, service })),
    };
  }

  const hasAnyLabelAttempt =
    rows.length > 0 ||
    Boolean(String(order?.shippo_label_url || "").trim()) ||
    Boolean(String(order?.admin_external_carrier || "").trim()) ||
    externalTrackingLinesFromRow(order).length > 0;

  if (hasAnyLabelAttempt) {
    const hasAnyTracking =
      Boolean(String(order?.shippo_tracking_number || "").trim()) ||
      rows.some((r) => String(r?.tracking_number || "").trim()) ||
      externalTrackingLinesFromRow(order).length > 0;
    if (!hasAnyTracking) {
      return {
        ok: false,
        error: "Tracking number is required before sending a buyer notification.",
        trackings: [],
      };
    }
  }

  return {
    ok: false,
    error: "A complete label or tracking record is required before sending a buyer notification.",
    trackings: [],
  };
}

/**
 * Load package labels and resolve notify fulfillment for an order.
 * @param {object} order
 * @returns {Promise<NotifyFulfillmentResolve>}
 */
export async function resolveBuyerShippingNotifyForOrder(order) {
  if (!order) {
    return {
      ok: false,
      error: "A complete label or tracking record is required before sending a buyer notification.",
      trackings: [],
    };
  }
  let labelRows = [];
  try {
    labelRows = await listOrderShippoLabels(order.id);
  } catch (err) {
    console.error("[admin] buyer notify: could not load order_shippo_labels", err);
    labelRows = [];
  }
  return resolveBuyerShippingNotifyFulfillment(order, labelRows);
}
