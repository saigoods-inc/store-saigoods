# Storefront release readiness — September 19, 2026

## Release scope
Responsive storefront, product selection, mini-cart, contact page and inquiry delivery, footer/navigation, checkout presentation, and runtime-backed SEO offers. Existing production payment, shipping, inventory, database runtime, and Square webhook implementations are unchanged. Cart entry adds validation while preserving the existing API contracts.

Sandbox database, credentials, test prices, notification suppression, and setup scripts must not be merged or promoted to production. Release from codex/storefront-ui-release, not codex/storefront-renovation.

## Verification
- 463 prior test executions passed across shipping/payment, SEO, storefront, contact/cart, and admin suites; coverage overlaps. Admin production build passed.
- Final focused contact/cart/bundle/checkout-entry rerun: 17 passed.
- Contact test was delivered to sales@saigoods.com and receipt confirmed.
- Existing GA4 property receives browsing/cart events; purchase is marked a key event but has no stream data in the last 28 days. Existing Ads account is linked and requests conversion tracking setup. Measurement follow-up is separate from storefront launch.
- Merchant Center: all three products approved; product IDs, landing URLs and prices match the production feed. Search Console: both submitted sitemaps successful.
- Final sandbox browser payment retest remains incomplete: browser shipping quote failed while direct sandbox API returned a valid $18.42 total for one Medium standard box. User reports this same sandbox behavior with the original design and working production checkout; accepted as a testing limitation rather than an established production regression. No claim of a successful current-build payment retest.

## Production configuration required before deployment
- CONTACT_RESEND_API_KEY: dedicated Resend sending-only secret scoped to verified saigoods.com, Production environment. User must supply directly in Vercel because the saved Preview sensitive value cannot be read back.
- CONTACT_FROM: SAI Goods Contact <contact@saigoods.com>
- CONTACT_TO: sales@saigoods.com
Preserve existing order-email credentials, payment keys, shipping settings and production catalog prices.

## Release sequence
1. Confirm production contact settings are present without displaying secret values.
2. Deploy the reviewed UI release using production environment settings. Never promote the sandbox artifact.
3. Check homepage, product pages, cart, contact and checkout rendering on store.saigoods.com.
4. Check an authorized shipping estimate without submitting payment. Verify production analytics configuration, canonical URLs, sitemap and Merchant feed.
5. Review runtime errors. A paid live order requires separate authorization.

## Rollback reference
Production before this release: dpl_6L6GPgHFb7TwdEgoJdqtX26df59B; main dfa4ca8cf81f787af78923616b2db5a0e59348dc. Recheck these references before launch. Keep the previous deployment available for rollback.
