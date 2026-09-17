// Only the isolated design-review server injects this marker.
export function isCheckoutDesignPreview() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && document.querySelector('meta[name="saigoods-design-preview"]')?.content === 'checkout';
}
