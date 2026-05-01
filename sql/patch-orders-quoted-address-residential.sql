-- Checkout quote snapshots: validated residential metadata + parcel count.
-- Safe to re-run.

alter table public.orders
  add column if not exists quoted_address_is_residential boolean not null default false,
  add column if not exists quoted_residential_surcharge_cents integer not null default 0,
  add column if not exists quoted_residential_surcharge_per_package_cents integer not null default 650,
  add column if not exists quoted_parcel_count integer not null default 0;

comment on column public.orders.quoted_address_is_residential is
  'True when Shippo-validated quote address is residential.';
comment on column public.orders.quoted_residential_surcharge_cents is
  'Residential surcharge charged to customer at quote time, cents.';
comment on column public.orders.quoted_residential_surcharge_per_package_cents is
  'Configured per-package residential surcharge in cents at quote time.';
comment on column public.orders.quoted_parcel_count is
  'Parcel count used for quote-time shipping and residential surcharge calculations.';

notify pgrst, 'reload schema';
