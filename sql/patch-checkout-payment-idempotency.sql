-- Run in Supabase before enabling live Square payments.
-- Makes browser/network retries reuse the same pending order and Square idempotency key.

alter table public.orders
  add column if not exists checkout_attempt_id uuid;

create unique index if not exists orders_checkout_attempt_id_unique
  on public.orders (checkout_attempt_id)
  where checkout_attempt_id is not null;

comment on column public.orders.checkout_attempt_id is
  'Browser-generated online checkout attempt id. Unique so payment retries reuse one order and one Square idempotency key.';
