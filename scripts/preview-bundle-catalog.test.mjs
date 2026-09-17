import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { primeRuntimeStore } from '../lib/runtime-store.js';
import { assertCartItemsHaveValidSupportedSizeAllocation } from '../lib/quote.js';
import { priceBundleLines } from '../lib/bundles.js';
import { normaliseBundleLinesForCart } from '../public/js/cart-store.js';

test('public five-box snapshot survives cart storage, quote validation, and pricing', async () => {
  process.env.NODE_ENV = 'development';
  process.env.RENOVATION_CATALOG_FILE = fileURLToPath(new URL('./preview-bundle-catalog.json', import.meta.url));
  const {store} = await primeRuntimeStore();
  for (const product of store.products) {
    const lines = normaliseBundleLinesForCart([{id:'5_boxes',qty:1}]);
    assert.deepEqual(lines, [{id:'5_boxes',qty:1}]);
    const size = product.supportedSizes[0];
    const item = {slug:product.slug,bundleLines:lines,quantities:{},boxQuantities:{[size]:5}};
    assert.doesNotThrow(() => assertCartItemsHaveValidSupportedSizeAllocation([item]));
    assert.throws(() => assertCartItemsHaveValidSupportedSizeAllocation([{...item,boxQuantities:{[size]:4}}]));
    const offer = product.bundles.find(b => b.id === '5_boxes');
    assert.equal(priceBundleLines(product,lines).totalCents,offer.priceCents);
  }
});
