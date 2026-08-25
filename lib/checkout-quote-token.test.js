import assert from "node:assert/strict";
import test from "node:test";
import {
  issueCheckoutQuoteToken,
  selectSignedCheckoutQuote,
  verifyCheckoutQuoteToken,
} from "./checkout-quote-token.js";

const items = [{ slug: "black-nitrile-general", quantities: { Medium: 3, Large: 2 } }];
const address = {
  line1: "2009 Ben Hill Ct",
  city: "Nolensville",
  state: "TN",
  postalCode: "37135",
  country: "US",
};
const quote = {
  canCheckout: true,
  subtotalCents: 34098,
  items: [{ slug: "black-nitrile-general", lineTotalCents: 34098 }],
  parcelSummary: { parcelCount: 6, parcels: [{ weight: "10" }] },
  shippingPackageLimit: { maxPackages: 12, packageCount: 6, exceeded: false },
  addressValidation: { normalizedAddress: address },
  shipping: {
    mode: "live_ups",
    quoteStatus: "rated",
    addressIsResidential: true,
    providerQuoteId: "package-set:ups:ups_ground_saver:6",
  },
  tax: { rateBps: 975 },
  shippingRateOptions: [
    {
      id: "package-set:ups:ups_ground_saver:6",
      provider: "UPS",
      serviceCode: "ups_ground_saver",
      serviceLabel: "Ground Saver",
      amountCents: 6983,
      bufferCents: 200,
      residentialSurchargeCents: 0,
      totalAmountCents: 7183,
    },
    {
      id: "package-set:ups:ups_ground:6",
      provider: "UPS",
      serviceCode: "ups_ground",
      serviceLabel: "Ground",
      amountCents: 7599,
      bufferCents: 200,
      residentialSurchargeCents: 0,
      totalAmountCents: 7799,
    },
  ],
};

function withSecret(fn) {
  const previous = process.env.CHECKOUT_QUOTE_SIGNING_SECRET;
  process.env.CHECKOUT_QUOTE_SIGNING_SECRET = "test-checkout-quote-secret-at-least-32-bytes";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous == null) delete process.env.CHECKOUT_QUOTE_SIGNING_SECRET;
      else process.env.CHECKOUT_QUOTE_SIGNING_SECRET = previous;
    });
}

test("signed quote verifies the exact cart and address without another carrier request", () =>
  withSecret(() => {
    const token = issueCheckoutQuoteToken({ quote, items, address, now: 1_000 });
    const payload = verifyCheckoutQuoteToken(token, { items, address, now: 2_000 });
    const selected = selectSignedCheckoutQuote(payload, {
      selectedShippingRateObjectId: "package-set:ups:ups_ground_saver:6",
      selectedShippingProvider: "UPS",
      selectedShippingServiceCode: "ups_ground_saver",
      selectedShippingAmountCents: 6983,
      selectedShippingParcelCount: 6,
    });

    assert.equal(selected.shipping.serviceLabel, "Ground Saver");
    assert.equal(selected.shippingCents, 7183);
    assert.equal(selected.taxCents, 4025);
    assert.equal(selected.totalCents, 45306);
    assert.equal(selected.shippingPackageLimit.maxPackages, 12);
    assert.equal(selected.canCheckout, true);
  }));

test("signed quote requires the shopper to explicitly select a service", () =>
  withSecret(() => {
    const token = issueCheckoutQuoteToken({ quote, items, address, now: 1_000 });
    const payload = verifyCheckoutQuoteToken(token, { items, address, now: 2_000 });
    assert.throws(() => selectSignedCheckoutQuote(payload), /Select a shipping service/i);
  }));

test("signed free-local-delivery quote needs no carrier selection", () =>
  withSecret(() => {
    const localQuote = {
      ...quote,
      shippingCents: 0,
      totalCents: quote.subtotalCents + 3325,
      taxCents: 3325,
      shipping: {
        mode: "local_delivery",
        quoteStatus: "local_delivery",
        provider: "local",
        serviceCode: "local_delivery",
        serviceLabel: "Free local delivery",
        amountCents: 0,
        totalAmountCents: 0,
        providerQuoteId: "local_delivery",
      },
      shippingRateOptions: [{
        id: "local_delivery",
        provider: "local",
        serviceCode: "local_delivery",
        serviceLabel: "Free local delivery",
        amountCents: 0,
        totalAmountCents: 0,
        automatic: true,
      }],
      freeDelivery: { applied: true, eligible: true, fulfillmentMethod: "local_delivery" },
    };
    const token = issueCheckoutQuoteToken({ quote: localQuote, items, address, now: 1_000 });
    const payload = verifyCheckoutQuoteToken(token, { items, address, now: 2_000 });
    const selected = selectSignedCheckoutQuote(payload);
    assert.equal(selected.shipping.mode, "local_delivery");
    assert.equal(selected.shippingCents, 0);
    assert.equal(selected.canCheckout, true);
  }));

test("signed quote supports a shopper switching to another signed service", () =>
  withSecret(() => {
    const token = issueCheckoutQuoteToken({ quote, items, address, now: 1_000 });
    const payload = verifyCheckoutQuoteToken(token, { items, address, now: 2_000 });
    const selected = selectSignedCheckoutQuote(payload, {
      selectedShippingRateObjectId: "package-set:ups:ups_ground:6",
      selectedShippingAmountCents: 7599,
      selectedShippingParcelCount: 6,
    });

    assert.equal(selected.shipping.serviceLabel, "Ground");
    assert.equal(selected.shippingCents, 7799);
    assert.equal(selected.totalCents, 45982);
  }));

test("signed quote keeps the carrier rate identity while applying free standard shipping", () =>
  withSecret(() => {
    const freeQuote = {
      ...quote,
      freeShipping: {
        configured: true,
        eligible: true,
        applied: true,
        zone: 3,
        thresholdCents: 15000,
        qualifyingRateId: "package-set:ups:ups_ground_saver:6",
        message: "Enjoy your free shipping!",
      },
      shippingRateOptions: quote.shippingRateOptions.map((rate, index) => index === 0
        ? {
            ...rate,
            carrierTotalAmountCents: rate.totalAmountCents,
            totalAmountCents: 0,
            totalAmountFormatted: "$0.00",
            residentialSurchargeCents: 0,
            freeShippingApplied: true,
            shippingDiscountCents: rate.totalAmountCents,
          }
        : rate),
    };
    const token = issueCheckoutQuoteToken({ quote: freeQuote, items, address, now: 1_000 });
    const payload = verifyCheckoutQuoteToken(token, { items, address, now: 2_000 });
    const selected = selectSignedCheckoutQuote(payload, {
      selectedShippingRateObjectId: "package-set:ups:ups_ground_saver:6",
      selectedShippingAmountCents: 6983,
      selectedShippingParcelCount: 6,
    });
    assert.equal(selected.shipping.providerQuoteId, "package-set:ups:ups_ground_saver:6");
    assert.equal(selected.shipping.carrierTotalAmountCents, 7183);
    assert.equal(selected.shippingCents, 0);
    assert.equal(selected.taxCents, 3325);
    assert.equal(selected.totalCents, 37423);
    assert.equal(selected.freeShipping.applied, true);
  }));

test("signed quote rejects tampering, changed checkout data, and expiration", () =>
  withSecret(() => {
    const token = issueCheckoutQuoteToken({ quote, items, address, now: 1_000 });
    assert.throws(
      () => verifyCheckoutQuoteToken(`${token}x`, { items, address, now: 2_000 }),
      /invalid/i,
    );
    assert.throws(
      () => verifyCheckoutQuoteToken(token, { items: [...items, { slug: "extra" }], address, now: 2_000 }),
      /Cart or address changed/i,
    );
    assert.throws(
      () => verifyCheckoutQuoteToken(token, { items, address: { ...address, postalCode: "37086" }, now: 2_000 }),
      /Cart or address changed/i,
    );
    assert.throws(
      () => verifyCheckoutQuoteToken(token, { items, address, now: 5 * 60 * 1_000 + 1_001 }),
      /expired/i,
    );
  }));
