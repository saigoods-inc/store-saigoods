# Contact inquiry delivery

The form POSTs to `/api/contact-inquiry`. Configure these **only for the Sandbox renovation Preview branch** to enable test delivery:

- `CONTACT_RESEND_API_KEY`: separate Resend sending key (do not reuse order-email credentials).
- `CONTACT_FROM`: sender allowed by that Resend account/domain.
- `CONTACT_TO`: approved test recipient inbox.

No fallback to production `RESEND_API_KEY` or `RESEND_FROM`. Missing configuration returns 503 with a clear message; the UI keeps entered details. Success is shown only after the provider accepts the email. Provider acceptance does not prove inbox delivery. The endpoint validates required fields, lengths, email, JSON size, and honeypot; it uses the existing per-instance request throttle (not a distributed abuse limit).

Five endpoint tests cover dedicated configuration, routing/reply-to, validation, delivery failure and honeypot. A real Sandbox delivery test remains pending the three settings. No test email has been sent.
