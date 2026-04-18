-- External / manual fulfillment records (carrier, tracking, uploaded label & packing slip).
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS).
--
-- Storage: create a private Supabase Storage bucket (default name: order-fulfillment-docs) and allow service-role uploads.
-- Set env SUPABASE_ORDER_DOCS_BUCKET on the API server if you use a different bucket name.
--
-- After running:
--   NOTIFY pgrst, 'reload schema';

alter table public.orders add column if not exists admin_external_carrier text;
alter table public.orders add column if not exists admin_external_service text;
alter table public.orders add column if not exists admin_external_label_cost_cents integer;
alter table public.orders add column if not exists admin_external_tracking_number text;
alter table public.orders add column if not exists admin_external_shipped_date text;
alter table public.orders add column if not exists admin_external_label_storage_path text;
alter table public.orders add column if not exists admin_external_packing_slip_storage_path text;
alter table public.orders add column if not exists admin_external_fulfillment_saved_at timestamptz;

comment on column public.orders.admin_external_carrier is 'Carrier or platform used to buy the label (UPS, USPS, Pirate Ship, Shippo, etc.).';
comment on column public.orders.admin_external_service is 'Optional service level (e.g. UPS Ground).';
comment on column public.orders.admin_external_label_cost_cents is 'Optional label purchase cost in USD cents.';
comment on column public.orders.admin_external_tracking_number is 'Tracking number from the external platform.';
comment on column public.orders.admin_external_shipped_date is 'Optional ship date YYYY-MM-DD.';
comment on column public.orders.admin_external_label_storage_path is 'Supabase Storage object path for uploaded shipping label.';
comment on column public.orders.admin_external_packing_slip_storage_path is 'Supabase Storage object path for uploaded packing slip.';
comment on column public.orders.admin_external_fulfillment_saved_at is 'When staff last saved external fulfillment fields.';

notify pgrst, 'reload schema';
