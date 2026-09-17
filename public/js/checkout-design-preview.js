import { setCheckoutSummaryValue } from './checkout-summary-value.js';
import { isCheckoutDesignPreview } from './checkout-preview-mode.js';

export function initCheckoutDesignPreview(root, quote) {
  if (!isCheckoutDesignPreview()) return;
  const q = selector => root.querySelector(selector);
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const scenario = new URLSearchParams(window.location.search).get('preview-result');
  const status = document.createElement('p');
  status.className = 'checkout-card-hint';
  status.setAttribute('role', 'status');
  status.setAttribute('data-preview-status', '');
  const pay = q('#checkout-pay');
  pay.after(status);
  const confirm = q('#checkout-update-totals');
  const fields = [...root.querySelectorAll('.checkout-form input, .checkout-form select')];
  const key = 'saigoods-checkout-design-draft';
  let confirmed = false;
  let epoch = 0;
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch {}
  fields.forEach(field => { if (typeof saved[field.name] === 'string') field.value = saved[field.name]; });
  const syncState = () => { q('.checkout-state-select__value').textContent = q('[name=state]').value || 'Select'; };
  syncState();
  q('#sq-card-container').textContent = 'Demo card •••• 4242 — no card details required';
  q('#sq-card-container').style.padding = '20px';
  q('#sq-card-container').previousElementSibling.textContent = 'Shipping, tax, and payment are simulated. No payment or order will be submitted.';
  pay.textContent = 'Preview payment';
  pay.disabled = true;
  function invalidate() {
    epoch++;
    confirmed = false;
    pay.disabled = true;
    confirm.disabled = false;
    confirm.textContent = 'Confirm address & discount';
    setCheckoutSummaryValue(q('#sum-ship'), '–');
    setCheckoutSummaryValue(q('#sum-tax'), '–');
    setCheckoutSummaryValue(q('#sum-total'), '—');
    q('#checkout-shipping-rates').hidden = true;
    status.textContent = '';
    try { sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(fields.map(f => [f.name, f.value])))); } catch {}
  }
  fields.forEach(field => { field.addEventListener('input', invalidate); field.addEventListener('change', invalidate); });
  const delay = () => new Promise(resolve => setTimeout(resolve, 450));
  confirm.addEventListener('click', async () => {
    const invalid = fields.find(field => field.required && !field.checkValidity());
    if (invalid) {
      status.textContent = 'Please complete the required contact and address fields.';
      if (invalid.name === 'state') q('.checkout-state-select__trigger').focus();
      else invalid.reportValidity();
      return;
    }
    const current = ++epoch;
    confirm.disabled = true;
    confirm.textContent = 'Checking address…';
    await delay();
    if (current !== epoch) return;
    confirm.disabled = false;
    confirm.textContent = 'Confirm address & discount';
    if (scenario === 'shipping-error') {
      status.textContent = 'Preview: shipping is unavailable for this address.';
      return;
    }
    q('#checkout-shipping-rates').hidden = false;
    q('#checkout-shipping-rates-list').innerHTML = '<label><input type="radio" checked name="preview-shipping"> Demo standard shipping · $12.00 · 3–5 business days</label>';
    const subtotal = quote.subtotalCents;
    const tax = Math.round(subtotal * 0.07);
    setCheckoutSummaryValue(q('#sum-ship'), '$12.00');
    setCheckoutSummaryValue(q('#sum-tax'), money(tax));
    setCheckoutSummaryValue(q('#sum-total'), money(subtotal + 1200 + tax));
    confirmed = true;
    pay.disabled = false;
    status.textContent = 'Sample totals ready. Any discount code is ignored in this design preview.';
  });
  pay.addEventListener('click', async () => {
    if (!confirmed) return;
    const current = epoch;
    pay.disabled = true;
    pay.textContent = 'Previewing payment…';
    await delay();
    pay.textContent = 'Preview payment';
    if (current !== epoch) return;
    pay.disabled = false;
    status.textContent = scenario === 'payment-error'
      ? 'Preview: payment declined. No charge was attempted.'
      : 'Preview complete! This is a simulated confirmation. No payment was taken, no order was created, and your cart is unchanged.';
    status.scrollIntoView({block:'center',behavior:'smooth'});
  });
}
