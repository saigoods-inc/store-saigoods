import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [baseUrl, vercelTokenPath, runtimeSecretsPath, checkoutUrlOutputPath, customerEmail] = process.argv.slice(2);
if (!baseUrl || !vercelTokenPath || !runtimeSecretsPath || !checkoutUrlOutputPath || !customerEmail) {
  console.error(
    "Usage: node scripts/create-preview-sandbox-manual-order.mjs <preview-url> <vercel-token-file> <runtime-secrets-file> <checkout-url-output-file> <customer-email>",
  );
  process.exit(2);
}
if (!/^https:\/\/store-saigoods-codex-preview\.vercel\.app\/?$/.test(baseUrl)) {
  throw new Error("Refusing to create a verification order outside the stable Codex Preview alias.");
}

const vercelToken = fs.readFileSync(vercelTokenPath, "utf8").trim();
const runtimeSecrets = JSON.parse(fs.readFileSync(runtimeSecretsPath, "utf8"));
const internalSecret = String(runtimeSecrets.INTERNAL_REPORTS_SECRET || "").trim();
if (!vercelToken || !internalSecret) throw new Error("Preview verification credentials are missing.");

function vercelRequest(path, { method = "GET", body } = {}) {
  const curlArgs = ["-sS", "-H", `Authorization: Bearer ${internalSecret}`];
  if (body !== undefined) {
    curlArgs.push("-X", method, "-H", "Content-Type: application/json", "--data-raw", JSON.stringify(body));
  }
  const result = spawnSync("npx", ["vercel", "curl", `${baseUrl}${path}`, "--", ...curlArgs], {
    cwd: process.cwd(),
    env: { ...process.env, VERCEL_TOKEN: vercelToken },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Preview request failed for ${path}.`);
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Preview returned a non-JSON response for ${path}.`);
  }
  if (json?.error) throw new Error(`${path}: ${json.error}`);
  return json;
}

const squareConfig = vercelRequest("/api/square-config");
if (String(squareConfig.squareEnvironment || "").toLowerCase() !== "sandbox") {
  throw new Error("Refusing verification because the Preview Square environment is not sandbox.");
}

const enteredAddress = {
  line1: "12685 Ulmerton Rd",
  line2: "",
  city: "Largo",
  state: "FL",
  postalCode: "33774",
  country: "US",
};
const verified = vercelRequest("/api/admin-address-verify", {
  method: "POST",
  body: { address: enteredAddress },
});
if (verified.verified !== true) throw new Error("The sandbox verification address was not accepted.");
const address = verified.normalizedAddress || verified.addressSuggestion || enteredAddress;
const items = [
  {
    slug: "nitrile-standard",
    bundleLines: [{ id: "box_1", qty: 1 }],
    quantities: {},
    boxQuantities: { M: 1 },
  },
];
const baseOrder = {
  name: "Sandbox automatic label verification",
  email: customerEmail,
  phone: "7275550100",
  address,
  items,
  fulfillmentMethod: "carrier",
  manualDiscountType: "none",
  manualDiscountValue: 0,
};

const initialQuote = vercelRequest("/api/admin-manual-order-estimate", {
  method: "POST",
  body: baseOrder,
});
const options = Array.isArray(initialQuote.shippingRateOptions) ? initialQuote.shippingRateOptions : [];
const selected = [...options]
  .filter((option) => option?.id && Number(option?.amountCents) > 0)
  .sort((a, b) => Number(a.amountCents) - Number(b.amountCents))[0];
if (!selected || !initialQuote.quoteToken) {
  console.error(
    JSON.stringify({
      canCheckout: initialQuote.canCheckout ?? null,
      userFacingError: initialQuote.userFacingError || null,
      warnings: initialQuote.warnings || [],
      shipping: initialQuote.shipping
        ? {
            provider: initialQuote.shipping.provider || null,
            quoteStatus: initialQuote.shipping.quoteStatus || null,
            serviceLabel: initialQuote.shipping.serviceLabel || null,
          }
        : null,
      rateCount: options.length,
    }),
  );
  throw new Error("No current sandbox carrier rate was returned.");
}

const selectedRateFields = {
  quoteToken: initialQuote.quoteToken,
  selectedShippingRateObjectId: selected.id,
  selectedShippingServiceCode: selected.serviceCode,
  selectedShippingServiceLabel: selected.serviceLabel,
  selectedShippingProvider: selected.provider,
  selectedShippingAmountCents: selected.amountCents,
  selectedShippingParcelCount: selected.parcelCount,
  selectedShippingResidentialSurchargeCents: selected.residentialSurchargeCents,
};
const confirmedQuote = vercelRequest("/api/admin-manual-order-estimate", {
  method: "POST",
  body: { ...baseOrder, ...selectedRateFields },
});
if (confirmedQuote.canCheckout !== true) throw new Error("The selected sandbox carrier rate could not be confirmed.");

const createBody = {
  ...baseOrder,
  ...selectedRateFields,
  quoteToken: confirmedQuote.quoteToken || initialQuote.quoteToken,
  paymentFlow: "square_payment_link",
  manualPaymentMethod: null,
  shipmentDate: "2026-08-18",
};
const created = vercelRequest("/api/admin-manual-order-create", { method: "POST", body: createBody });
if (!created.orderId) throw new Error("The sandbox draft was created without an order id.");
const sent = vercelRequest("/api/admin-manual-order-send-link", {
  method: "POST",
  body: { ...baseOrder, ...selectedRateFields, orderId: String(created.orderId), shipmentDate: "2026-08-18" },
});
if (!sent.checkoutUrl) throw new Error("Square did not return a sandbox checkout URL.");
fs.writeFileSync(checkoutUrlOutputPath, `${sent.checkoutUrl}\n`, { mode: 0o600 });

console.log(
  JSON.stringify({
    ok: true,
    orderId: String(created.orderId),
    orderRef: created.orderRef || null,
    service: selected.serviceLabel || selected.serviceCode || null,
    shippingAmountCents: selected.amountCents,
    totalFormatted: created.totalFormatted || confirmedQuote.totalFormatted || null,
    emailed: sent.emailed === true,
  }),
);
