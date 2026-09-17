import { isCheckoutDesignPreview } from './checkout-preview-mode.js';
import { getCart } from './cart-store.js';
import { getCartQuote, createCheckout } from './catalog.js';
import { trackBeginCheckout } from './analytics.js';

// Reuse the existing checkout contracts; the server remains authoritative.
export async function continueToCheckout(store, dependencies = {}) {
  const readCart = dependencies.getCart || getCart;
  const quoteCart = dependencies.getCartQuote || getCartQuote;
  const create = dependencies.createCheckout || createCheckout;
  const navigate = dependencies.navigate || (url => { window.location.href = url; });
  const track = dependencies.trackBeginCheckout || trackBeginCheckout;
  const items = readCart(store.site.sizes);
  if (!items.length) throw new Error('Your cart is empty. Add products before checking out.');
  if (store.site.storefrontGlobalOutOfStock) throw new Error('We’re restocking. Please try again when products are available.');
  const quote = await quoteCart(items);
  if (JSON.stringify(items) !== JSON.stringify(readCart(store.site.sizes))) throw new Error('Your cart changed. Please review it and continue again.');
  if (!quote.items?.length) throw new Error('Your cart could not be confirmed. Please review your items.');
  if (quote.shippingPackageLimit?.exceeded) throw new Error('Orders are limited to 10 shipping packages. Please reduce your quantity.');
  if (isCheckoutDesignPreview()) {
    navigate('/checkout.html');
    return;
  }
  if (!quote.squareReady) throw new Error('Checkout is currently unavailable. Please try again later.');
  if (quote.useEmbeddedCheckout) {
    navigate('/checkout.html');
  } else {
    track(quote);
    const response = await create(items);
    navigate(response.checkoutUrl);
  }
}
