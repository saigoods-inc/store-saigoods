import { isStorefrontPaymentLinkCompatibleWithShippingMode } from "./checkout-totals.js";

/**
 * Flags for cart UI: embedded Web Payments vs legacy Payment Link.
 */
export function enrichCartQuoteApiResponse(quote) {
  const supabaseOk = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
  const webhookSigConfigured = Boolean(
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() ||
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX?.trim(),
  );
  const squareCore = Boolean(
    process.env.SQUARE_ACCESS_TOKEN?.trim() &&
      process.env.SQUARE_LOCATION_ID?.trim() &&
      process.env.PUBLIC_BASE_URL?.trim() &&
      webhookSigConfigured,
  );

  const useEmbeddedCheckout = Boolean(
    squareCore && supabaseOk && process.env.SQUARE_APPLICATION_ID?.trim(),
  );
  const paymentLinkReady = Boolean(
    squareCore && supabaseOk && isStorefrontPaymentLinkCompatibleWithShippingMode(),
  );

  return {
    ...quote,
    useEmbeddedCheckout,
    squareReady: useEmbeddedCheckout || paymentLinkReady,
    checkoutReady: useEmbeddedCheckout || paymentLinkReady,
  };
}
