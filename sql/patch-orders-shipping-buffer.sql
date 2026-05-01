-- Phase 4.5: track provider line vs customer buffer (e.g. $2) on top of live Shippo/UPS.
-- Prefer the consolidated migration: patch-orders-checkout-quote-columns.sql (rerunnable; includes PostgREST reload).
alter table public.orders add column if not exists quoted_shipping_base_amount_cents integer not null default 0;
alter table public.orders add column if not exists quoted_shipping_buffer_cents integer not null default 0;

comment on column public.orders.quoted_shipping_amount_cents is 'Customer-facing carrier line in cents (provider quote + buffer when SHIPPING_BUFFER_CENTS is set).';
comment on column public.orders.quoted_shipping_base_amount_cents is 'Provider-quoted line before buffer, cents (live Shippo/UPS).';
comment on column public.orders.quoted_shipping_buffer_cents is 'Extra cents added at quote time (e.g. SHIPPING_BUFFER_CENTS=200 for $2).';
