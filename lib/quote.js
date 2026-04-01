import { getProductMap, getKnownSizes } from "./store.js";

export function buildQuote(items) {
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
      const lineCases = getLineCases(quantities);

      if (!lineCases) {
        return null;
      }

      const lineTotalCents = lineCases * product.priceCents;
      subtotalCents += lineTotalCents;
      totalCases += lineCases;

      return {
        slug: product.slug,
        name: product.name,
        shortName: product.shortName,
        cardImage: product.cardImage,
        priceCents: product.priceCents,
        priceFormatted: formatCurrency(product.priceCents),
        quantities,
        lineCases,
        lineTotalCents,
        lineTotalFormatted: formatCurrency(lineTotalCents),
      };
    })
    .filter(Boolean);

  const shippingCents = 0;
  const taxCents = 0;
  const totalCents = subtotalCents + shippingCents + taxCents;

  return {
    items: quoteItems,
    subtotalCents,
    subtotalFormatted: formatCurrency(subtotalCents),
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
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

