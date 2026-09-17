import { continueToCheckout } from './checkout-entry.js';
import { getCart, removeProduct } from './cart-store.js';
import { getCartQuote, formatSizeLineText } from './catalog.js';

export function initMiniCart(store, escapeHtml) {
  const trigger = document.querySelector('.cart-link');
  if (!trigger || trigger.getAttribute('aria-current') === 'page' || document.querySelector('#mini-cart') || document.querySelector('[data-checkout-root]')) return;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/css/mini-cart.css';
  document.head.append(style);
  const dialog = document.createElement('dialog');
  dialog.id = 'mini-cart';
  dialog.className = 'mini-cart';
  dialog.setAttribute('aria-labelledby', 'mini-cart-title');
  dialog.innerHTML = `<header class="mini-cart__header"><h2 id="mini-cart-title">Cart</h2><button type="button" class="mini-cart__close" aria-label="Close cart" autofocus><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></header><div class="mini-cart__items" aria-live="polite"></div><footer class="mini-cart__footer"></footer>`;
  document.body.append(dialog);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', dialog.id);
  const body = dialog.querySelector('.mini-cart__items');
  const footer = dialog.querySelector('.mini-cart__footer');
  let revision = 0;
  let checkingOut = false;
  let previousStyle;
  let scrollY = 0;
  let backdropStart = false;
  let closing = false;
  const close = async () => {
    if (!dialog.open || closing) return;
    closing = true;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const destination = window.matchMedia('(max-width: 760px)').matches ? 'translateY(100%)' : 'translateX(100%)';
      const animation = dialog.animate(
        [{ transform: getComputedStyle(dialog).transform }, { transform: destination }],
        { duration: 200, easing: 'ease-in', fill: 'forwards' },
      );
      await animation.finished.catch(() => {});
      dialog.close();
      animation.cancel();
    } else {
      dialog.close();
    }
    closing = false;
  };
  const grip = dialog.querySelector('.mini-cart__header');
  let drag = null;
  let snapBack = null;
  const resetDrag = () => {
    if (drag && grip.hasPointerCapture(drag.id)) grip.releasePointerCapture(drag.id);
    drag = null;
    snapBack?.cancel();
    snapBack = null;
    dialog.style.removeProperty('transform');
  };
  grip.addEventListener('pointerdown', event => {
    if (!matchMedia('(max-width: 760px)').matches || !event.isPrimary || event.button !== 0 || closing || event.target.closest('button')) return;
    snapBack?.cancel();
    drag = {id: event.pointerId, y: event.clientY, distance: 0};
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.distance = Math.max(0, event.clientY - drag.y);
    dialog.style.transform = `translateY(${drag.distance}px)`;
  });
  const finishDrag = (event, cancelled = false) => {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = drag.distance;
    drag = null;
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    if (!cancelled && distance >= 80) {
      void close();
      return;
    }
    const animation = dialog.animate(
      [{transform: `translateY(${distance}px)`}, {transform: 'translateY(0)'}],
      {duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180, easing: 'ease-out'}
    );
    snapBack = animation;
    dialog.style.removeProperty('transform');
    animation.finished.then(() => { if (snapBack === animation) snapBack = null; }).catch(() => {});
  };
  grip.addEventListener('pointerup', event => finishDrag(event));
  grip.addEventListener('pointercancel', event => finishDrag(event, true));
  grip.addEventListener('lostpointercapture', event => finishDrag(event, true));
  dialog.addEventListener('close', resetDrag);
  matchMedia('(max-width: 760px)').addEventListener('change', resetDrag);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void close();
  });
  dialog.querySelector('.mini-cart__close').addEventListener('click', close);
  dialog.addEventListener('pointerdown', event => {
    const r = dialog.getBoundingClientRect();
    backdropStart = event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  });
  dialog.addEventListener('click', async event => {
    if (event.target.closest('.mini-cart__checkout')) {
      event.preventDefault();
      if (checkingOut) return;
      checkingOut = true;
      const checkout = footer.querySelector('.mini-cart__checkout');
      checkout.setAttribute('aria-disabled', 'true');
      checkout.textContent = 'Opening checkout…';
      footer.querySelector('[role=alert]')?.remove();
      try {
        await continueToCheckout(store);
      } catch (error) {
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = error.message;
        footer.append(message);
      } finally {
        checkingOut = false;
        checkout.removeAttribute('aria-disabled');
        checkout.innerHTML = 'Continue to checkout <span aria-hidden="true">→</span>';
      }
      return;
    }
    const r = dialog.getBoundingClientRect();
    if (backdropStart && event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) close();
    backdropStart = false;
    const button = event.target.closest('button');
    if (button?.hasAttribute('data-remove')) {
      removeProduct(button.dataset.remove, store.site.sizes);
      dialog.querySelector('.mini-cart__close').focus();
    }
    if (button?.hasAttribute('data-continue')) close();
    if (button?.hasAttribute('data-retry')) void render();
  });
  dialog.addEventListener('close', () => {
    revision++;
    if (previousStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', previousStyle);
    window.scrollTo({ top: scrollY, behavior: 'instant' });
    trigger.focus({ preventScroll: true });
  });
  trigger.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (dialog.open) return;
    previousStyle = document.body.getAttribute('style');
    scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    dialog.showModal();
    void render();
  });
  const refresh = () => { if (dialog.open) void render(); };
  window.addEventListener('cart:updated', refresh);
  window.addEventListener('storage', event => { if (!event.key || event.key === 'saigoods-cart-v1') refresh(); });

  async function render() {
    const current = ++revision;
    const items = getCart(store.site.sizes);
    footer.innerHTML = '';
    if (!items.length) {
      body.removeAttribute('aria-busy');
      body.innerHTML = '<div class="mini-cart__empty"><h3>Your cart is empty</h3><p>Add a few essentials, then review them here.</p><button type="button" class="mini-cart__continue" data-continue>Continue shopping</button></div>';
      return;
    }
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = '<p class="mini-cart__notice">Updating your cart…</p>';
    try {
      const quote = await getCartQuote(items);
      if (current !== revision || !dialog.open) return;
      if (!quote.items?.length || !Number.isFinite(quote.subtotalCents)) throw new Error('Quote unavailable');
      body.innerHTML = quote.items.map(item => {
        const sizes = [...new Set([...Object.keys(item.quantities || {}), ...Object.keys(item.boxQuantities || {})])];
        const details = sizes.map(size => formatSizeLineText(size, item.quantities, item.boxQuantities)).filter(Boolean);
        const url = `/products/${encodeURIComponent(item.slug)}`;
        return `<article class="mini-cart__item"><img src="${escapeHtml(item.cardImage)}" alt="${escapeHtml(item.name)}" width="80" height="80"><div><h3><a href="${url}">${escapeHtml(item.name)}</a></h3><ul>${details.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul><strong>${escapeHtml(item.lineTotalFormatted)}</strong><div class="mini-cart__item-actions"><a href="${url}" aria-label="Edit sizes & quantity for ${escapeHtml(item.name)}" title="Edit sizes & quantity"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Z M13 6l5 5"/></svg></a><button type="button" data-remove="${escapeHtml(item.slug)}" aria-label="Remove ${escapeHtml(item.name)}" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></div></div></article>`;
      }).join('');
      footer.innerHTML = `<div class="mini-cart__subtotal"><span>Subtotal</span><strong>${escapeHtml(quote.subtotalFormatted)}</strong></div><p>Shipping and taxes calculated at checkout.</p><a class="mini-cart__checkout" href="/cart.html">Continue to checkout <span aria-hidden="true">→</span></a>`;
    } catch {
      if (current !== revision || !dialog.open) return;
      body.innerHTML = '<p class="mini-cart__notice" role="alert">We couldn’t update your cart. Please try again.</p><button class="mini-cart__continue" type="button" data-retry>Try again</button><p><a href="/cart.html">Review your cart</a></p>';
    } finally {
      if (current === revision) body.removeAttribute('aria-busy');
    }
  }
}
