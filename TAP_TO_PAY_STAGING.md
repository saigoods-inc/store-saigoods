# Tap to Pay staging

This branch is intentionally staging-only. `lib/tap-to-pay.js` refuses to enable the feature when `VERCEL_ENV=production`, even if every feature variable is present.

## Required Preview variables

- `TAP_TO_PAY_STAGING_ENABLED=true`
- `TAP_TO_PAY_ISOLATED_DATA_ACK=staging`
- `TAP_TO_PAY_ADMIN_EMAILS=<comma-separated approved admins>`
- `TAP_TO_PAY_STATE_SECRET=<at least 32 random characters>`
- `TAP_TO_PAY_CALLBACK_URL=https://<preview-host>/admin-v2.5/orders`
- `TAP_TO_PAY_SQUARE_APPLICATION_ID=<staging Square app id>`
- `TAP_TO_PAY_SQUARE_LOCATION_ID=<staging Square location id>`
- `TAP_TO_PAY_SQUARE_ACCESS_TOKEN=<staging Square production token>`
- `TAP_TO_PAY_SIMULATION_ENABLED=true` for the isolated simulator; disable it before controlled real-card testing.

The Preview environment must use a separate Supabase project. Do not set `TAP_TO_PAY_ISOLATED_DATA_ACK=staging` until `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` have been verified as belonging to that project.

## Square setup

Register the exact Preview callback URL under the Square Developer Console's Point of Sale API Web callback. The Square Point of Sale API does not support Sandbox card transactions, so the final phone test requires a dedicated production Square test location, a small real card payment, and an immediate refund.

## Test order lifecycle

1. Create a local-delivery order using **Tap to Pay in Orders (staging)**.
2. Open the order and confirm it shows **Tap to Pay pending**.
3. Use the staging simulator for callback, retry, and idempotency tests.
4. On an approved phone, use **Pay now with Square** for the controlled real-card test.
5. Confirm the order is **Paid** but not completed.
6. Upload delivery proof and complete handoff; only that action commits inventory.

Cancellation, wrong-total, expired-state, wrong-location, duplicate-callback, app-not-installed, and interrupted-app-switch scenarios must pass before production design work starts.
