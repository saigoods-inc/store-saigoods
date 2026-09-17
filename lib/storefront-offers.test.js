import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStorefrontOffers, preferredCaseOffer, withStorefrontOffers } from './storefront-offers.js';
import { priceBundleLines } from './bundles.js';
import { productJsonLd, renderMerchantFeed } from './seo.js';
import { inventoryAllowsAllocations, isSizeChannelPurchasable } from '../public/js/size-availability.js';
const product = {
  slug: 'test', name: 'Test', currency: 'USD', boxesPerCase: 10, supportedSizes: ['S', 'M'],
  bundles: [{ id: 'case_1', kind: 'case', units: 1, priceCents: 8000 },
    { id: 'box_1', kind: 'box', units: 1, priceCents: 900 },
    { id: 'case_5', kind: 'case', units: 5, priceCents: 40000 }],
};
const stock = (cases, boxes) => ({ ...product, inventory: { lines: [
  { productSlug: 'test', size: 'S', channel: 'case', active: true, track: true, available: cases },
  { productSlug: 'test', size: 'S', channel: 'box', active: true, track: true, available: boxes },
  { productSlug: 'test', size: 'M', channel: 'case', active: true, track: true, available: 0 },
  { productSlug: 'test', size: 'M', channel: 'box', active: true, track: true, available: 0 },
] } });
test('display offer uses quote pricing; no promotion without a qualifying backend rule', () => {
  for (const active of [false, true]) {
    const p = { ...product, volumePricing: { active, minCases: 5, pricePerCaseCents: 7000 } };
    for (const offer of resolveStorefrontOffers(p)) {
      assert.equal(offer.priceCents, priceBundleLines(p, [{ id: offer.id, qty: 1 }]).totalCents);
      assert.equal(Boolean(offer.promotion), active && offer.id === 'case_5');
    }
    assert.equal(preferredCaseOffer(p).priceCents, 8000);
  }
});
test('renamed single-case offer is supported; missing/disabled offers never use legacy price', () => {
  assert.equal(preferredCaseOffer({ ...product, bundles: [{ ...product.bundles[0], id: 'carton' }] }).id, 'carton');
  assert.equal(preferredCaseOffer({ ...product, priceCents: 1, bundles: [{ ...product.bundles[0], active: false }] }), null);
  assert.equal(preferredCaseOffer({ ...product, bundles: [{ ...product.bundles[0], units: 5 }] }), null);
});
test('loose boxes cannot become cases, but intact cases can supply boxes', () => {
  const loose = stock(0, 20);
  assert.equal(preferredCaseOffer(loose).available, false);
  assert.equal(withStorefrontOffers(loose).storefront.available, true);
  assert.equal(isSizeChannelPurchasable(loose, 'S', 'case'), false);
  assert.equal(inventoryAllowsAllocations(loose, { S: 1 }, {}, ['S']), false);
  const intact = stock(1, 0);
  assert.equal(isSizeChannelPurchasable(intact, 'S', 'box'), true);
  assert.equal(inventoryAllowsAllocations(intact, { S: 1 }, { S: 1 }, ['S']), false);
  assert.equal(inventoryAllowsAllocations(intact, {}, { S: 10 }, ['S']), true);
});
test('schema and merchant case availability agree with the public offer', () => {
  for (const p of [stock(0, 20), stock(1, 0), { ...stock(1, 0), inventory: { ...stock(1, 0).inventory, globalOutOfStock: true } }]) {
    const offer = preferredCaseOffer(p);
    const schema = productJsonLd(p, {}, { offerId: offer.id })['@graph'].find(n => n['@type'] === 'Product').offers;
    assert.equal(schema.price, (offer.priceCents / 100).toFixed(2));
    assert.equal(schema.availability.endsWith('/InStock'), offer.available);
    assert.ok(renderMerchantFeed([p]).includes(`<g:availability>${offer.available ? 'in_stock' : 'out_of_stock'}</g:availability>`));
  }
});
test('multi-case offer availability can span supported sizes but excludes unsupported sizes', () => {
  const p = stock(2, 0);
  p.inventory.lines[2].available = 3;
  assert.equal(resolveStorefrontOffers(p).find(o => o.id === 'case_5').available, true);
  p.supportedSizes = ['S'];
  assert.equal(resolveStorefrontOffers(p).find(o => o.id === 'case_5').available, false);
});

test('frontend allocation checks match physical checkout for tracked case/box combinations', async () => {
  const { calculateStockAfterDemand } = await import('./inventory-service.js');
  for (const cases of [0, 1, 3]) for (const boxes of [0, 4, 15]) {
    for (const requestedCases of [0, 1, 2, 4]) for (const requestedBoxes of [0, 1, 10, 21]) {
      const expected = calculateStockAfterDemand({ casesOnHand: cases, looseBoxesOnHand: boxes,
        boxesPerCase: 10, requestedCases, requestedBoxes }).ok;
      assert.equal(inventoryAllowsAllocations(stock(cases, boxes), { S: requestedCases },
        { S: requestedBoxes }, ['S']), expected);
    }
  }
});
