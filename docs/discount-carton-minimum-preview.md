# Minimum-carton discount codes

Admin can set an optional minimum carton quantity alongside a code's existing percentage. Zero keeps the existing no-minimum behavior. Only actual cartons count, across products and sizes; loose boxes and shipping parcel counts do not qualify. Once eligible, the existing merchandise percentage calculation, single-use claim, and non-stacking rules still apply.

Checkout shows the code, percentage, and confirmed requirement when accepted. A rejected code states the minimum, current cartons, and quantity still needed. Removing a code or changing a cart clears the old quote and savings, and requires confirmation again. Contact/address inputs survive the Edit cart round trip within the same browser session; payment data is never saved.

## Deleting unused codes

Admins can select Delete beside an unused code and confirm the exact code in a dialog. Cancel leaves it unchanged. A successful deletion removes the row and updates the counts; failures show an error without claiming success. Used codes, codes with redemption timestamps, and codes linked to orders cannot be deleted. The server checks these conditions atomically in the delete statement so a concurrent checkout claim is protected. A deleted code is no longer valid for checkout. This addition requires no database migration. Quotes and claims retain the discount row identity, so deleting and recreating the same code text cannot reuse an old discount amount. Quotes created before identity tracking must be refreshed; existing manual drafts with a code must be re-quoted and saved before sending a payment link.

## Review scenarios

Use disposable codes in the isolated preview database:

| Code | Discount | Minimum | Expected result |
| --- | --- | --- | --- |
| PSD398O | 5% | 1 | One carton qualifies; boxes alone do not |
| FRIYAY999 | 10% | 5 | Four cartons rejects; five mixed cartons qualifies |
| A fresh legacy-style code | Any valid % | 0 | Existing box-only behavior is preserved |

Also check four cartons plus ten loose boxes, removing the code, editing the cart after confirmation, and a product with a non-stacking automatic volume price. The final payment endpoint independently checks eligibility, including requests using a signed quote.

## Release sequence

1. Apply `sql/patch-discount-code-min-cartons.sql` to the isolated preview database.
2. Publish this feature branch as a Vercel Preview with sandbox-only settings.
3. Review admin creation/listing, unused-code deletion and cancellation, and shopper success/rejection.
4. After user approval, apply the same additive migration to production before deploying the application change. Existing rows receive zero automatically.

Do not merge or deploy to production before approval. Code rollback can retain the new column; the previous version ignores it.

For this review, `CHECKOUT_PREVIEW_ONLY=true` works only together with `VERCEL_ENV=preview` and `SQUARE_ENVIRONMENT=sandbox`. It enables browsing checkout without Square credentials and rejects payment before order creation. Shipping uses a test token, and address verification and email credentials are disabled. The preview uses branch-specific environment settings. Automatic feature-branch deployments were enabled only after those sandbox settings were verified; production settings are unchanged.

## Validation

`npm test` includes the new discount tests. Admin unit/integration suites cover the surrounding existing behavior. The admin production build passes. The standalone TypeScript check has eight pre-existing errors in unchanged admin pages, reproduced from the main baseline; this feature introduces no additional type errors.

After release, the release owner should check admin code creation, a qualifying estimate, a below-minimum rejection, and an existing zero-minimum code immediately and again after initial customer usage. Unexpected missing-column errors, incorrect savings, or lost shipping/payment functionality require rollback of the application deployment and investigation. A below-minimum rejection is expected behavior. No production release has been approved by this document.
