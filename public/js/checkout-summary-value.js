/** Keep unknown totals visually light while calculated prices retain their emphasis. */
export function setCheckoutSummaryValue(element, value) {
  element.textContent = value;
  element.classList.toggle('checkout-total-placeholder', /^[–—]$/.test(String(value).trim()));
}
