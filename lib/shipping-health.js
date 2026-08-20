import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { isShippoLabelDbLockEnabled } from "./shippo-label-purchase-claim.js";
import { loadDefaultShipFromOverride } from "./warehouse-settings.js";
import { isCheckoutAddressValidationEnabled } from "./address-validation.js";

const EVENT_TYPES = new Set(["checkout_rate", "admin_rate", "label_purchase"]);
const OUTCOMES = new Set(["success", "no_rates", "fallback", "partial", "failed", "locked"]);
const ERROR_CODES = new Set([
  "SHIPPO_NO_RATES",
  "SHIPPO_NO_COMMON_PACKAGE_SERVICE",
  "SHIPPO_SHIPMENT_ID_MISSING",
  "SHIPPO_TIMEOUT",
  "SHIPPO_FETCH_FAILED",
  "SHIPPO_HTTP_ERROR",
  "LABEL_PURCHASE_FAILED",
  "LABEL_PURCHASE_PARTIAL",
  "LABEL_PURCHASE_LOCKED",
  "UNKNOWN",
]);

let warnedUnavailable = false;

function boundedInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1_000_000) : null;
}

export function sanitizeShippingHealthEvent(event = {}) {
  const eventType = EVENT_TYPES.has(event.eventType) ? event.eventType : null;
  const outcome = OUTCOMES.has(event.outcome) ? event.outcome : "failed";
  const rawCode = String(event.errorCode || "").trim().toUpperCase();
  return {
    event_type: eventType,
    outcome,
    provider: String(event.provider || "shippo").trim().toLowerCase().slice(0, 30) || "shippo",
    order_id: event.orderId == null || event.orderId === "" ? null : event.orderId,
    error_code: rawCode ? (ERROR_CODES.has(rawCode) ? rawCode : "UNKNOWN") : null,
    parcel_count: boundedInt(event.parcelCount),
    rate_count: boundedInt(event.rateCount),
    duration_ms: boundedInt(event.durationMs),
  };
}

export async function recordShippingHealthEvent(event, { client: injectedClient } = {}) {
  const row = sanitizeShippingHealthEvent(event);
  if (!row.event_type) return false;
  try {
    const client = injectedClient || getSupabaseServiceRoleClient();
    const { error } = await client.from("shipping_health_events").insert(row);
    if (error) throw error;
    return true;
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn("[shipping-health] telemetry unavailable", String(error?.message || error));
    }
    return false;
  }
}

function envFlag(raw) {
  return ["1", "true", "on", "yes", "enabled"].includes(String(raw || "").trim().toLowerCase());
}

export function shippingRuntimeReadiness({ warehouseConfigured: warehouseOverride } = {}) {
  const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
  const carrierIds = [
    String(process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID || "").trim(),
    ...String(process.env.SHIPPO_CARRIER_ACCOUNT_IDS || "").split(",").map((value) => value.trim()),
  ].filter(Boolean);
  const provider = String(process.env.SHIPPING_RATE_PROVIDER || "shippo").trim().toLowerCase();
  const tokenMode = token.startsWith("shippo_live_") ? "live" : token ? "test" : "missing";
  const providerConfigured = provider === "shippo";
  const tokenConfigured = tokenMode !== "missing";
  const shippoConfigured = providerConfigured && tokenConfigured;
  const checkoutAddressValidationEnabled = isCheckoutAddressValidationEnabled();
  return {
    provider,
    providerConfigured,
    tokenConfigured,
    shippoConfigured,
    tokenMode,
    carrierAccountCount: carrierIds.length,
    warehouseConfigured: typeof warehouseOverride === "boolean"
      ? warehouseOverride
      : ["SHIPPO_FROM_STREET1", "SHIPPO_FROM_CITY", "SHIPPO_FROM_STATE", "SHIPPO_FROM_ZIP"].every(
          (key) => Boolean(String(process.env[key] || "").trim()),
        ),
    fallbackEnabled: envFlag(process.env.CHECKOUT_LIVE_SHIPPING_FALLBACK),
    databasePurchaseLockEnabled: isShippoLabelDbLockEnabled(),
    checkoutAddressValidationEnabled,
    checkoutAddressValidationReady: shippoConfigured && checkoutAddressValidationEnabled,
    warehouseAddressValidationReady: shippoConfigured,
  };
}

export async function fetchShippingHealthSnapshot({ client: injectedClient } = {}) {
  const warehouse = await loadDefaultShipFromOverride({ client: injectedClient });
  const runtime = shippingRuntimeReadiness({
    warehouseConfigured: Boolean(warehouse?.line1 && warehouse?.city && warehouse?.state && warehouse?.postalCode),
  });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const client = injectedClient || getSupabaseServiceRoleClient();
    const { data, error } = await client
      .from("shipping_health_events")
      .select("event_type,outcome,error_code,parcel_count,rate_count,duration_ms,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const events = Array.isArray(data) ? data : [];
    const counts = events.reduce((acc, row) => {
      const key = OUTCOMES.has(row.outcome) ? row.outcome : "failed";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return { generatedAt: new Date().toISOString(), telemetryAvailable: true, runtime, last24Hours: { total: events.length, counts }, recent: events.slice(0, 20) };
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      telemetryAvailable: false,
      runtime,
      last24Hours: { total: 0, counts: {} },
      recent: [],
      warning: "Install the Phase 6 shipping migration to enable health history.",
    };
  }
}
