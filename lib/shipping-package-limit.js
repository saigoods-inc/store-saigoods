import {
  buildFulfillmentPackingPlan,
  loadRuntimeFulfillmentPackagingConfig,
} from "./fulfillment-cartonization.js";

export const MAX_ONLINE_SHIPPING_PACKAGES = 10;
export const SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL = "sales@saigoods.com";

export function shippingPackageLimitState(parcelSource) {
  const parcels = Array.isArray(parcelSource?.parcels) ? parcelSource.parcels : null;
  const packageCount = Math.max(
    parcels?.length || 0,
    Math.max(0, Math.floor(Number(parcelSource?.parcelCount) || 0)),
  );
  const exceeded = packageCount > MAX_ONLINE_SHIPPING_PACKAGES;
  const message = exceeded
    ? "Orders are limited to 10 shipping packages. Please reduce the quantity or complete your current order before adding more."
    : null;

  return {
    maxPackages: MAX_ONLINE_SHIPPING_PACKAGES,
    packageCount,
    exceeded,
    contactEmail: SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL,
    message,
  };
}

export async function resolveOnlineShippingPackagePlan(items) {
  const config = await loadRuntimeFulfillmentPackagingConfig();
  const plan = buildFulfillmentPackingPlan(
    { items: Array.isArray(items) ? items : [] },
    { config },
  );
  const parcels = Array.isArray(plan?.parcels) ? plan.parcels : [];
  const parcelSummary = {
    source: plan?.source || "cartonization",
    planId: plan?.planId || null,
    parcelCount: parcels.length,
    parcels,
    fulfillmentUnits: Array.isArray(plan?.fulfillmentUnits) ? plan.fulfillmentUnits : [],
    parcelContents: Array.isArray(plan?.parcelContents) ? plan.parcelContents : [],
    candidates: Array.isArray(plan?.candidates) ? plan.candidates : [],
  };

  return {
    plan,
    parcelSummary,
    limit: shippingPackageLimitState(parcelSummary),
  };
}
