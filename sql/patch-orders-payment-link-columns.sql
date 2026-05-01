-- Payment link columns on public.orders (manual Square link flow, admin display).
-- Fixes PostgREST: "Could not find the 'payment_link_expires_at' column ... in the schema cache"
-- when lib/orders.js updateOrderPaymentLinkSent() updates these fields.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS only; does not drop or rename columns.
-- After running in Supabase SQL Editor, PostgREST reloads its schema cache.

alter table public.orders add column if not exists payment_link_url text;
alter table public.orders add column if not exists payment_link_id text;
alter table public.orders add column if not exists payment_link_created_at timestamptz;
alter table public.orders add column if not exists payment_link_status text;
alter table public.orders add column if not exists payment_link_sent_at timestamptz;
alter table public.orders add column if not exists payment_link_expires_at timestamptz;

comment on column public.orders.payment_link_url is
  'Square Online Checkout payment link URL when staff emailed the customer.';
comment on column public.orders.payment_link_id is
  'Optional Square payment link id from API response, if stored for support or webhooks.';
comment on column public.orders.payment_link_created_at is
  'Optional timestamp when Square created the payment link.';
comment on column public.orders.payment_link_status is
  'Optional Square-reported status for the payment link (e.g. from API), if stored.';
comment on column public.orders.payment_link_sent_at is
  'When the payment link was last stored on this order (same update as payment_link_url).';
comment on column public.orders.payment_link_expires_at is
  'Suggested expiry for display (e.g. sent time + policy window); enforcement is app-side until implemented.';

notify pgrst, 'reload schema';
