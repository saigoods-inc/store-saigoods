alter table public.orders add column if not exists paid_shipping_amount_cents integer not null default 0;
alter table public.orders add column if not exists quoted_shipping_mode text;
alter table public.orders add column if not exists quoted_shipping_status text;
alter table public.orders add column if not exists quoted_shipping_amount_cents integer not null default 0;
alter table public.orders add column if not exists quoted_shipping_residential_surcharge_cents integer not null default 0;
alter table public.orders add column if not exists quoted_shipping_total_cents integer not null default 0;
alter table public.orders add column if not exists quoted_shipping_service_code text;
alter table public.orders add column if not exists quoted_shipping_service_label text;
alter table public.orders add column if not exists quoted_shipping_currency text;
alter table public.orders add column if not exists quoted_shipping_provider text;
alter table public.orders add column if not exists quoted_shipping_provider_quote_id text;
alter table public.orders add column if not exists quoted_parcel_summary_json jsonb;
alter table public.orders add column if not exists quoted_address_snapshot_json jsonb;
alter table public.orders add column if not exists quoted_taxable_shipping_cents integer not null default 0;

update public.orders
set paid_shipping_amount_cents = greatest(0, coalesce(shipping_cents, 0))
where paid_shipping_amount_cents is null
   or paid_shipping_amount_cents = 0;

update public.orders
set quoted_shipping_total_cents = greatest(0, coalesce(shipping_cents, 0))
where quoted_shipping_total_cents is null
   or quoted_shipping_total_cents = 0;

comment on column public.orders.paid_shipping_amount_cents is 'Shipping amount charged to customer at payment finalization; keep shipping_cents mirrored during transition.';
comment on column public.orders.quoted_shipping_mode is 'Quote shipping mode snapshot (e.g. baked_in, live_ups).';
comment on column public.orders.quoted_shipping_status is 'Quote shipping status snapshot (e.g. quoted, included_in_merchandise, invalid_address).';
comment on column public.orders.quoted_shipping_amount_cents is 'Base quoted shipping amount before surcharge, cents.';
comment on column public.orders.quoted_shipping_residential_surcharge_cents is 'Quoted residential surcharge, cents.';
comment on column public.orders.quoted_shipping_total_cents is 'Quoted shipping line charged to customer, cents.';
comment on column public.orders.quoted_shipping_service_code is 'Quoted carrier service code.';
comment on column public.orders.quoted_shipping_service_label is 'Quoted carrier service display label.';
comment on column public.orders.quoted_shipping_currency is 'Quoted shipping currency (USD).';
comment on column public.orders.quoted_shipping_provider is 'Quoted shipping provider identifier (e.g. ups).';
comment on column public.orders.quoted_shipping_provider_quote_id is 'Provider quote/rate identifier captured at quote time.';
comment on column public.orders.quoted_parcel_summary_json is 'Quoted parcel planning snapshot used for shipping quote.';
comment on column public.orders.quoted_address_snapshot_json is 'Quoted ship-to snapshot (input + normalized/validated shape).';
comment on column public.orders.quoted_taxable_shipping_cents is 'Quoted shipping amount that is taxable, cents.';
