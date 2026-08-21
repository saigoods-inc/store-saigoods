import { isStorefrontPaymentLinkCompatibleWithShippingMode } from "./checkout-totals.js";

function configured(value) {
  return Boolean(String(value || "").trim());
}

export function paymentRuntimeReadiness() {
  const rawEnvironment = String(process.env.SQUARE_ENVIRONMENT || "").trim().toLowerCase();
  const environment = rawEnvironment === "sandbox" || rawEnvironment === "production"
    ? rawEnvironment
    : rawEnvironment
      ? "invalid"
      : "missing";
  const accessTokenConfigured = configured(process.env.SQUARE_ACCESS_TOKEN);
  const applicationIdConfigured = configured(process.env.SQUARE_APPLICATION_ID);
  const locationIdConfigured = configured(process.env.SQUARE_LOCATION_ID);
  const publicBaseUrlConfigured = configured(process.env.PUBLIC_BASE_URL);
  const databaseConfigured = configured(process.env.SUPABASE_URL) && configured(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const resendApiKeyConfigured = configured(process.env.RESEND_API_KEY);
  const resendFromConfigured = configured(process.env.RESEND_FROM);
  const webhookSignatureConfigured = environment === "sandbox"
    ? configured(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX)
    : environment === "production"
      ? configured(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY)
      : false;
  const environmentConfigured = environment === "sandbox" || environment === "production";
  const coreConfigured = accessTokenConfigured && locationIdConfigured && publicBaseUrlConfigured && databaseConfigured && webhookSignatureConfigured;

  return {
    provider: "square",
    environment,
    environmentConfigured,
    sandboxPolicyCompliant: environment === "sandbox",
    accessTokenConfigured,
    applicationIdConfigured,
    locationIdConfigured,
    publicBaseUrlConfigured,
    databaseConfigured,
    webhookSignatureConfigured,
    coreConfigured,
    embeddedCheckoutReady: environmentConfigured && coreConfigured && applicationIdConfigured,
    paymentLinkReady: environmentConfigured && coreConfigured && isStorefrontPaymentLinkCompatibleWithShippingMode(),
    resendApiKeyConfigured,
    resendFromConfigured,
    paymentLinkEmailReady: resendApiKeyConfigured && resendFromConfigured,
  };
}

export function fetchPaymentHealthSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    runtime: paymentRuntimeReadiness(),
  };
}
