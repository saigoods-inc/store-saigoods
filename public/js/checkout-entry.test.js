import test from 'node:test';
import assert from 'node:assert/strict';
import { continueToCheckout } from './checkout-entry.js';
const store = { site: { sizes: ['Small'] } };
const items = [{ slug: 'sample', boxQuantities: { Small: 1 }, bundleLines: [{ id: 'box', qty: 1 }] }];
function setup(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    getCart: () => items,
    getCartQuote: async () => ({ items, squareReady: true, useEmbeddedCheckout: true }),
    createCheckout: async payload => { calls.push(['create', payload]); return { checkoutUrl: 'https://example.com/pay' }; },
    navigate: url => calls.push(['navigate', url]),
    trackBeginCheckout: () => calls.push(['track']),
    ...overrides,
  } };
}
test('embedded checkout bypasses cart without creating a hosted payment', async () => {
  const { calls, deps } = setup(); await continueToCheckout(store, deps);
  assert.deepEqual(calls, [['navigate', '/checkout.html']]);
});
test('hosted checkout keeps original cart payload and server URL', async () => {
  const { calls, deps } = setup({ getCartQuote: async () => ({ items, squareReady: true, useEmbeddedCheckout: false }) });
  await continueToCheckout(store, deps);
  assert.deepEqual(calls, [['track'], ['create', items], ['navigate', 'https://example.com/pay']]);
});
for (const [name, patch] of [['unavailable', { squareReady: false }], ['package limit', { shippingPackageLimit: { exceeded: true } }], ['empty quote', { items: [] }]]) {
  test(`${name} blocks payment and navigation`, async () => {
    const { calls, deps } = setup({ getCartQuote: async () => ({ items, squareReady: true, ...patch }) });
    await assert.rejects(continueToCheckout(store, deps)); assert.deepEqual(calls, []);
  });
}
test('empty cart and global out of stock block checkout', async () => {
  const { calls, deps } = setup();
  await assert.rejects(continueToCheckout(store, { ...deps, getCart: () => [] }));
  await assert.rejects(continueToCheckout({site:{...store.site, storefrontGlobalOutOfStock:true}}, deps));
  assert.deepEqual(calls, []);
});
test('cart changes during quote and API failures block navigation', async () => {
  let reads = 0;
  const { calls, deps } = setup({getCart: () => ++reads === 1 ? items : []});
  await assert.rejects(continueToCheckout(store, deps), /cart changed/);
  await assert.rejects(continueToCheckout(store, {...deps, getCart:()=>items, getCartQuote:async()=>{throw new Error('Offline');}}), /Offline/);
  assert.deepEqual(calls, []);
});
