import {
  bundleLinesTotalCents,
  getBoxesPerCase,
  isBundleAllocationValid,
  normaliseBundleLines,
} from "./bundles.js";
import { productCaseCentsForTier } from "./pricing-tier.js";
import { getProductMap, getSupportedSizesForProduct } from "./store.js";

/**
 * Case/box counts per size for stock checks — same normalization and bundle rules as {@link buildQuote}.
 * @param {Array} items — cart lines `{ slug, quantities, boxQuantities?, bundleLines? }`
 * @returns {Map<string, number>} keys `${slug}\t${size}\tcase` or `${slug}\t${size}\tbox` → units
 */
export function collectPhysicalStockDemands(items) {
  const productMap = getProductMap();
  const demand = new Map();
  const normalizedItems = Array.isArray(items) ? items : [];

  for (const item of normalizedItems) {
    const product = productMap.get(item.slug);
    if (!product) {
      continue;
    }

    const sizes = getSupportedSizesForProduct(product);
    const quantities = normalizeQuantities(item.quantities, sizes);
    const boxQuantities = normalizeQuantities(item.boxQuantities, sizes);
    let bundleLines = normaliseBundleLines(item.bundleLines);

    const sumCase = getLineCases(quantities);
    const sumBox = getLineCases(boxQuantities);
    if (!sumCase && !sumBox) {
      continue;
    }

    if (
      bundleLines.length &&
      !isBundleAllocationValid(product, bundleLines, quantities, boxQuantities, sizes)
    ) {
      bundleLines = [];
    }

    for (const size of sizes) {
      const c = quantities[size] || 0;
      const b = boxQuantities[size] || 0;
      if (c > 0) {
        const k = `${product.slug}\t${size}\tcase`;
        demand.set(k, (demand.get(k) || 0) + c);
      }
      if (b > 0) {
        const k = `${product.slug}\t${size}\tbox`;
        demand.set(k, (demand.get(k) || 0) + b);
      }
    }
  }

  return demand;
}

/**
 * @param {Array} items — cart lines `{ slug, quantities, boxQuantities?, bundleLines? }`
 * @param {{ omitShippingEstimate?: boolean, pricingTier?: "standard" | "hardin" }} [options]
 *   Merchandise-only: shipping is applied in `buildFullCheckoutQuote` (Shippo + flat rates).
 */
export function buildQuote(items, options = {}) {
  const omitShippingEstimate = options.omitShippingEstimate === true;
  const pricingTier = options.pricingTier === "hardin" ? "hardin" : "standard";
  const productMap = getProductMap();

  const normalizedItems = Array.isArray(items) ? items : [];
  let subtotalCents = 0;
  let totalCases = 0;

  const quoteItems = normalizedItems
    .map((item) => {
      const product = productMap.get(item.slug);

      if (!product) {
        return null;
      }

      const sizes = getSupportedSizesForProduct(product);
      const quantities = normalizeQuantities(item.quantities, sizes);
      const boxQuantities = normalizeQuantities(item.boxQuantities, sizes);
      let bundleLines = normaliseBundleLines(item.bundleLines);

      const sumCase = getLineCases(quantities);
      const sumBox = getLineCases(boxQuantities);

      if (!sumCase && !sumBox) {
        return null;
      }

      if (
        bundleLines.length &&
        !isBundleAllocationValid(product, bundleLines, quantities, boxQuantities, sizes)
      ) {
        bundleLines = [];
      }

      const boxesPerCase = getBoxesPerCase(product);
      const lineShippingUnits = Math.ceil(sumCase + sumBox / boxesPerCase);

      const caseCents = productCaseCentsForTier(product, pricingTier);
      let lineTotalCents;
      if (bundleLines.length) {
        lineTotalCents = bundleLinesTotalCents(product, bundleLines, pricingTier);
      } else if (sumBox > 0) {
        const boxUnit = Math.max(1, Math.round(caseCents / boxesPerCase));
        lineTotalCents = sumCase * caseCents + sumBox * boxUnit;
      } else {
        lineTotalCents = sumCase * caseCents;
      }

      subtotalCents += lineTotalCents;
      totalCases += lineShippingUnits;

      const row = {
        slug: product.slug,
        name: product.name,
        shortName: product.shortName,
        cardImage: product.cardImage,
        priceCents: caseCents,
        priceFormatted: formatCurrency(caseCents),
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

  const shippingCents = 0;
  const taxCents = 0;
  const totalCents = subtotalCents + shippingCents + taxCents;
  const shippingQuoteComplete = quoteItems.length === 0 || omitShippingEstimate;

  return {
    items: quoteItems,
    subtotalCents,
    subtotalFormatted: formatCurrency(subtotalCents),
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
    shippingZone: null,
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
