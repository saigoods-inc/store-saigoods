-- Manual order Square payment link: record when the link was written and a 24-hour expiry window
-- (display in admin; enforcement is future work).
-- Safe to re-run; does not modify existing row data.

alter table public.orders
  add column if not exists payment_link_sent_at timestamptz,
  add column if not exists payment_link_expires_at timestamptz;

comment on column public.orders.payment_link_sent_at is
  'When the payment link was last stored on this order (same update as payment_link_url).';
comment on column public.orders.payment_link_expires_at is
  'Suggested expiry (sent time + 24 hours) for the current 24h payment policy; display only until enforced.';

notify pgrst, 'reload schema';
