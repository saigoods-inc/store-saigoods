import { priceBundleLines } from './bundles.js';
import { getSizePurchaseCapacity } from '../public/js/size-availability.js';

// Prices are for one bundle, not one glove/box unless the bundle explicitly says so.
export function resolveStorefrontOffers(product) {
  return (product.bundles || []).filter(b => b.active !== false &&
    ['case', 'box'].includes(b.kind) && Number.isInteger(Number(b.units)) && Number(b.units) > 0 &&
    Number.isSafeInteger(Number(b.priceCents)) && Number(b.priceCents) > 0).map(bundle => {
      const priced = priceBundleLines(product, [{ id: bundle.id, qty: 1 }]);
      return {
        ...bundle,
        regularPriceCents: Number(bundle.priceCents),
        priceCents: priced.totalCents,
        promotion: priced.volumePricing ? { type: 'volume', ...priced.volumePricing } : null,
        available: offerAvailable(product, bundle),
      };
    });
}

export function offerAvailable(product, offer) {
  if (product?.inventory?.globalOutOfStock) return false;
  const lines = product?.inventory?.lines || [];
  // Retain the existing untracked-stock policy. Quote/checkout always revalidate.
  if (!lines.length) return true;
  const sizes = product.supportedSizes?.length ? product.supportedSizes : [...new Set(lines.map(l => l.size).filter(Boolean))];
  if (!sizes.length) {
    // Older snapshots without size identity: do not invent cross-channel allocations.
    return lines.some(l => l.active !== false && (!offer || !l.channel || l.channel === offer.kind) &&
      Number(l.available) >= Number(offer?.units || 1));
  }
  const capacity = sizes.reduce((sum, size) => {
    const stock = getSizePurchaseCapacity(product, size);
    return sum + (offer?.kind === 'case' ? stock.cases : stock.boxes);
  }, 0);
  return capacity >= Number(offer?.units || 1);
}

export function preferredCaseOffer(product) {
  const offers = resolveStorefrontOffers(product);
  return offers.find(b => b.id === 'case_1' && b.kind === 'case' && Number(b.units) === 1) ||
    offers.find(b => b.kind === 'case' && Number(b.units) === 1) || null;
}

export function withStorefrontOffers(product) {
  const offers = resolveStorefrontOffers(product);
  const featured = offers.find(b => b.id === 'case_1' && b.kind === 'case' && Number(b.units) === 1) ||
    offers.find(b => b.kind === 'case' && Number(b.units) === 1) || null;
  return { ...product, storefront: { offers, featuredOffer: featured, available: offers.some(o => o.available) } };
}
