-- Vendor paid-order notification deduplication (Resend).
-- Safe to re-run; does not modify existing row data.

alter table public.orders
  add column if not exists vendor_paid_notification_claimed_at timestamptz,
  add column if not exists vendor_paid_notification_sent_at timestamptz,
  add column if not exists vendor_paid_notification_resend_id text,
  add column if not exists vendor_paid_notification_error text;

comment on column public.orders.vendor_paid_notification_claimed_at is
  'When a Square webhook worker claimed the right to send the vendor paid-order email; cleared after send or release. Stale claims may be reclaimed.';
comment on column public.orders.vendor_paid_notification_sent_at is
  'When the vendor paid-order notification was successfully sent via Resend; null until first successful send.';
comment on column public.orders.vendor_paid_notification_resend_id is
  'Resend email id returned after a successful vendor paid-order notification send.';
comment on column public.orders.vendor_paid_notification_error is
  'Safe, length-limited summary of the last vendor notification failure after a released claim; not secrets or raw provider payloads.';

notify pgrst, 'reload schema';
