import {
  bundleLinesTotalCents,
  getBoxesPerCase,
  isBundleAllocationValid,
  normaliseBundleLines,
} from "./bundles.js";
import { getProductMap, getKnownSizes } from "./store.js";
import {
  calculateCartShipping,
  getShippingProductTypeForSlug,
  getShippingZone,
  normalizeUsZip,
} from "./shipping.js";

/**
 * @param {Array} items — cart lines `{ slug, quantities, boxQuantities?, bundleLines? }`
 * @param {{ zipCode?: string, omitShippingEstimate?: boolean }} [options]
 *   - `zipCode` — 5-digit US ZIP (or ZIP+4) for UPS zone + shipping on this quote
 *   - `omitShippingEstimate` — merchandise-only quote (shipping/total exclude shipping; used for cart + payment-link subtotal)
 */
export function buildQuote(items, options = {}) {
  const omitShippingEstimate = options.omitShippingEstimate === true;
  const productMap = getProductMap();
  const knownSizes = getKnownSizes();

  const normalizedItems = Array.isArray(items) ? items : [];
  let subtotalCents = 0;
  let totalCases = 0;

  const quoteItems = normalizedItems
    .map((item) => {
      const product = productMap.get(item.slug);

      if (!product) {
        return null;
      }

      const quantities = normalizeQuantities(item.quantities, knownSizes);
      const boxQuantities = normalizeQuantities(item.boxQuantities, knownSizes);
      let bundleLines = normaliseBundleLines(item.bundleLines);

      const sumCase = getLineCases(quantities);
      const sumBox = getLineCases(boxQuantities);

      if (!sumCase && !sumBox) {
        return null;
      }

      if (
        bundleLines.length &&
        !isBundleAllocationValid(product, bundleLines, quantities, boxQuantities, knownSizes)
      ) {
        bundleLines = [];
      }

      const boxesPerCase = getBoxesPerCase(product);
      const lineShippingUnits = Math.ceil(sumCase + sumBox / boxesPerCase);

      let lineTotalCents;
      if (bundleLines.length) {
        lineTotalCents = bundleLinesTotalCents(product, bundleLines);
      } else if (sumBox > 0) {
        const boxUnit = Math.max(1, Math.round(product.priceCents / boxesPerCase));
        lineTotalCents = sumCase * product.priceCents + sumBox * boxUnit;
      } else {
        lineTotalCents = sumCase * product.priceCents;
      }

      subtotalCents += lineTotalCents;
      totalCases += lineShippingUnits;

      const row = {
        slug: product.slug,
        name: product.name,
        shortName: product.shortName,
        cardImage: product.cardImage,
        priceCents: product.priceCents,
        priceFormatted: formatCurrency(product.priceCents),
        quantities,
        boxQuantities,
        bundleLines,
        lineCases: sumCase,
        lineBoxCount: sumBox,
        lineShippingUnits,
        lineTotalCents,
        lineTotalFormatted: formatCurrency(lineTotalCents),
      };

      return row;
    })
    .filter(Boolean);

  const zipNormalized = omitShippingEstimate ? null : normalizeUsZip(options.zipCode);
  let shippingCents = 0;
  let shippingZone = null;

  if (zipNormalized && quoteItems.length) {
    shippingZone = getShippingZone(zipNormalized);
    const shippingLines = quoteItems.map((item) => ({
      productType: getShippingProductTypeForSlug(item.slug),
      quantity: item.lineShippingUnits,
    }));
    const shippingDollars = calculateCartShipping(zipNormalized, shippingLines);
    shippingCents = Math.round(shippingDollars * 100);
  }

  const taxCents = 0;
  const totalCents = subtotalCents + shippingCents + taxCents;
  const shippingQuoteComplete =
    quoteItems.length === 0 || omitShippingEstimate || zipNormalized !== null;

  return {
    items: quoteItems,
    subtotalCents,
    subtotalFormatted: formatCurrency(subtotalCents),
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
    shippingZone,
    shippingQuoteComplete,
    taxCents,
    taxFormatted: formatCurrency(taxCents),
    totalCents,
    totalFormatted: formatCurrency(totalCents),
    totalCases,
  };
}

export function normalizeQuantities(quantities, knownSizes) {
  return knownSizes.reduce((result, size) => {
    const rawValue = quantities && Object.hasOwn(quantities, size) ? quantities[size] : 0;
    const parsed = Number(rawValue);
    result[size] = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    return result;
  }, {});
}

export function getLineCases(quantities) {
  return Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
}

export function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents) || 0) / 100);
}

