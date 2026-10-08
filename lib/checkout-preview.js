/** Review discounts on Vercel Preview without enabling payment or order creation. */
export function isCheckoutPreviewOnly(env = process.env) {
  return env.VERCEL_ENV === "preview" &&
    env.SQUARE_ENVIRONMENT === "sandbox" &&
    env.CHECKOUT_PREVIEW_ONLY === "true";
}
