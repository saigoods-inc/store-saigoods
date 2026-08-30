# Google Analytics 4 setup

The storefront includes GA4 page measurement and these ecommerce events:

- `view_item_list`
- `view_item`
- `add_to_cart`
- `view_cart`
- `remove_from_cart`
- `begin_checkout`
- `purchase`

Analytics is disabled unless `GA4_MEASUREMENT_ID` contains a valid GA4 web stream ID.
Localhost is excluded by default so development traffic does not pollute production reports.

## Connect the store

1. In Google Analytics, create or select a GA4 property.
2. Go to **Admin → Data collection and modification → Data streams**.
3. Create a **Web** stream for the production store domain.
4. Copy the Measurement ID, which starts with `G-`.
5. In Vercel, open the store project and add `GA4_MEASUREMENT_ID` as a **Config** value under
   **Settings → Environment Variables** for Production (and Preview if desired).
6. Redeploy the store.

No Google API secret is required. A GA4 Measurement ID is intentionally public.

## Verify before relying on the reports

1. Open the deployed store in a private window.
2. In GA4, open **Reports → Realtime** and confirm the visit appears.
3. View a product, add it to the cart, open checkout, and complete a sandbox/test order.
4. In GA4, use **Admin → DebugView** or the Realtime event list to confirm the ecommerce events.
5. Confirm that `purchase` contains the order reference as `transaction_id`, USD revenue,
   tax, shipping, and product lines.

To test analytics on localhost intentionally, add `?ga_debug=1` to the page URL. Do not use
that parameter for routine development.

## Reporting and privacy

The store sends product, cart, checkout, and order totals. It does not send shopper names,
email addresses, phone numbers, street addresses, card details, or Square payment IDs.

GA4 is useful for traffic, acquisition, and funnel trends. The order database remains the
source of truth for sales and revenue because consent choices, blockers, and network failures
can prevent analytics events from being recorded.

Before enabling analytics, update the store privacy/cookie notice for the markets where the
store operates. The current integration disables Google Signals and ad-personalization signals;
advertising features and consent-mode behavior should be added only as part of a deliberate
privacy and advertising setup.
