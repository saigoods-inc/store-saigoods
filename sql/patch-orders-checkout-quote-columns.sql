-- Align public.orders with checkout quote snapshots (see lib/orders.js → buildOrderQuoteSnapshotColumns).
-- Fixes PostgREST errors such as: missing column quoted_shipping_base_amount_cents in schema cache.
--
-- Rerunnable: every ADD uses IF NOT EXISTS.
--
-- Where to run (Supabase hosted):
--   Dashboard → SQL Editor → New query → paste this file → Run.
--
-- After run: restart local Node server if needed; retry checkout.
--
-- Note: Shippo “service level” token/name are stored as quoted_shipping_service_code and
-- quoted_shipping_service_label (not separate *servicelevel* columns — avoids duplicate semantics).

alter table public.orders
  add column if not exists paid_shipping_amount_cents integer not null default 0,
  add column if not exists quoted_shipping_mode text,
  add column if not exists quoted_shipping_status text,
  add column if not exists quoted_shipping_amount_cents integer not null default 0,
  add column if not exists quoted_shipping_base_amount_cents integer not null default 0,
  add column if not exists quoted_shipping_buffer_cents integer not null default 0,
  add column if not exists quoted_shipping_residential_surcharge_cents integer not null default 0,
  add column if not exists quoted_shipping_total_cents integer not null default 0,
  add column if not exists quoted_shipping_service_code text,
  add column if not exists quoted_shipping_service_label text,
  add column if not exists quoted_shipping_currency text default 'USD',
  add column if not exists quoted_shipping_provider text,
  add column if not exists quoted_shipping_provider_quote_id text,
  add column if not exists quoted_parcel_summary_json jsonb,
  add column if not exists quoted_address_snapshot_json jsonb,
  add column if not exists quoted_taxable_shipping_cents integer not null default 0;

-- Ask PostgREST to reload schema cache (Supabase API layer).
notify pgrst, 'reload schema';

comment on column public.orders.paid_shipping_amount_cents is 'Shipping amount charged to customer at payment finalization; keep shipping_cents mirrored during transition.';
comment on column public.orders.quoted_shipping_mode is 'Quote shipping mode snapshot (e.g. baked_in, live_ups).';
comment on column public.orders.quoted_shipping_status is 'Quote shipping status snapshot (e.g. quoted, included_in_merchandise, invalid_address).';
comment on column public.orders.quoted_shipping_amount_cents is 'Customer-facing carrier line in cents (may include buffer; see quoted_shipping_base_amount_cents).';
comment on column public.orders.quoted_shipping_base_amount_cents is 'Provider-quoted line before buffer, cents (live Shippo/UPS).';
comment on column public.orders.quoted_shipping_buffer_cents is 'Cents added at quote time (e.g. SHIPPING_BUFFER_CENTS).';
comment on column public.orders.quoted_shipping_residential_surcharge_cents is 'Quoted residential surcharge, cents.';
comment on column public.orders.quoted_shipping_total_cents is 'Quoted shipping + residential surcharge, cents.';
comment on column public.orders.quoted_shipping_service_code is 'Quoted carrier service token/code (e.g. Shippo servicelevel.token).';
comment on column public.orders.quoted_shipping_service_label is 'Quoted carrier service display label (e.g. Shippo servicelevel.name).';
comment on column public.orders.quoted_shipping_currency is 'Quoted shipping currency (default USD).';
comment on column public.orders.quoted_shipping_provider is 'Quoted shipping provider identifier (e.g. shippo, ups).';
comment on column public.orders.quoted_shipping_provider_quote_id is 'Provider quote/rate identifier captured at quote time.';
comment on column public.orders.quoted_parcel_summary_json is 'Quoted parcel planning snapshot used for shipping quote.';
comment on column public.orders.quoted_address_snapshot_json is 'Quoted ship-to snapshot (input + normalized/validated shape).';
comment on column public.orders.quoted_taxable_shipping_cents is 'Quoted shipping amount that is taxable, cents.';
