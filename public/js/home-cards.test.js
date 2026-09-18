import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderCatalogCards } from './home-cards.js';
const store = JSON.parse(readFileSync(new URL('../../data/store.json', import.meta.url)));

test('initial HTML contains all product cards without baking stock or prices', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Loading products/);
  for (const product of store.products) assert.ok(html.includes(`data-product-slug="${product.slug}"`));
  const cards = html.split('<!-- catalog:start -->')[1].split('<!-- catalog:end -->')[0];
  assert.doesNotMatch(cards, /Out of stock|Unavailable|per case/);
  assert.match(cards, /See available options/);
});
test('fresh availability renders an unavailable card and live price', () => {
  const product = {...store.products[0], storefront: {available:false, featuredOffer:{priceCents:12345, available:false}}};
  const html = renderCatalogCards([product]);
  assert.match(html, /Out of stock/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /123/);
});
test('catalog text is escaped in both initial and refreshed cards', () => {
  const html = renderCatalogCards([{...store.products[0],name:'<script>bad</script>', subtext:'<img onerror="bad">'}]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
