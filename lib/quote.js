import {
  bundleLinesTotalCents,
  getBoxesPerCase,
  isBundleAllocationValid,
  normaliseBundleLines,
} from "./bundles.js";
import { productCaseCentsForTier } from "./pricing-tier.js";
import { getProductMap, getSupportedSizesForProduct } from "./store.js";

/**
 * One cart/line: same normalisation, bundle-stripping, and per-size channel counts as
 * `buildQuote` and {@link collectPhysicalStockDemands}. Uses only {@link getSupportedSizesForProduct}
 * so allocation keys match inventory + parcel expansion.
 *
 * @returns {{ product: object, sizes: string[], quantities: object, boxQuantities: object, bundleLines: { id: string, qty: number }[], hasPhysicalDemand: boolean }}
 */
export function normalizeItemLineForOrderProcessing(item, product) {
  if (!item || !product) {
    return {
      product: null,
      sizes: [],
      quantities: {},
      boxQuantities: {},
      bundleLines: [],
      hasPhysicalDemand: false,
    };
  }
  const sizes = getSupportedSizesForProduct(product);
  const quantities = normalizeQuantities(item.quantities, sizes);
  const boxQuantities = normalizeQuantities(item.boxQuantities, sizes);
  let bundleLines = normaliseBundleLines(item.bundleLines);
  const sumCase = getLineCases(quantities);
  const sumBox = getLineCases(boxQuantities);
  if (!sumCase && !sumBox) {
    bundleLines = [];
  } else if (
    bundleLines.length &&
    !isBundleAllocationValid(product, bundleLines, quantities, boxQuantities, sizes)
  ) {
    bundleLines = [];
  }
  return {
    product,
    sizes,
    quantities,
    boxQuantities,
    bundleLines,
    hasPhysicalDemand: sumCase > 0 || sumBox > 0,
  };
}

/**
 * Sum of all case + box counts the client sent (any size key), before supported-size filtering.
 * @param {object} [item]
 * @returns {number}
 */
export function rawSizeIntentTotalCount(item) {
  let t = 0;
  for (const map of [item?.quantities, item?.boxQuantities]) {
    if (!map || typeof map !== "object") {
      continue;
    }
    for (const v of Object.values(map)) {
      const n = Math.floor(Number(v) || 0);
      if (Number.isFinite(n) && n > 0) {
        t += n;
      }
    }
  }
  return t;
}

const ERR_BUNDLE_NO_SUPPORTED_SIZE =
  "Selected bundle has no valid supported size allocation. Please choose a supported size.";
const ERR_QUANTITY_UNSUPPORTED_SIZES =
  "Quantity is set on sizes this product does not offer, or the line could not be applied. Use only the sizes available for this product.";

/**
 * Reject lines with bundle selection or per-size counts that do not map to any supported size
 * (e.g. only "S" for an M/L-only product). Run before stock checks. Safe for website checkout
 * and admin manual order APIs.
 * @param {Array} items
 */
export function assertCartItemsHaveValidSupportedSizeAllocation(items) {
  const list = Array.isArray(items) ? items : [];
  const productMap = getProductMap();
  for (const item of list) {
    const slug = String(item?.slug || "").trim();
    if (!slug) {
      continue;
    }
    const product = productMap.get(slug);
    if (!product) {
      continue;
    }
    const n = normalizeItemLineForOrderProcessing(item, product);
    if (n.hasPhysicalDemand) {
      continue;
    }
    const rawBundles = normaliseBundleLines(item?.bundleLines);
    if (rawBundles.length > 0) {
      const e = new Error(ERR_BUNDLE_NO_SUPPORTED_SIZE);
      e.statusCode = 400;
      throw e;
    }
    if (rawSizeIntentTotalCount(item) < 1) {
      continue;
    }
    const e = new Error(ERR_QUANTITY_UNSUPPORTED_SIZES);
    e.statusCode = 400;
    throw e;
  }
}

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

    const n = normalizeItemLineForOrderProcessing(item, product);
    if (!n.hasPhysicalDemand) {
      continue;
    }

    for (const size of n.sizes) {
      const c = n.quantities[size] || 0;
      const b = n.boxQuantities[size] || 0;
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

      const n = normalizeItemLineForOrderProcessing(item, product);
      if (!n.hasPhysicalDemand) {
        return null;
      }
      const { quantities, boxQuantities, bundleLines } = n;
      const sumCase = getLineCases(quantities);
      const sumBox = getLineCases(boxQuantities);

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
