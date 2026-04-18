-- Complete Shippo shipment + label + debug columns for public.orders.
-- Run once in Supabase SQL Editor (or psql) if you see:
--   "Could not find the 'shippo_parcel_audit_json' column ... in the schema cache"
-- Safe to run multiple times (IF NOT EXISTS).
--
-- After running, refresh PostgREST schema cache so the API sees new columns:
--   NOTIFY pgrst, 'reload schema';
-- In Supabase Dashboard: Settings → API → "Reload schema" (if shown), or wait ~1 min.

-- --- Shipment + parcel audit (from patch-orders-shippo-shipment.sql) ---
alter table public.orders add column if not exists shippo_shipment_object_id text;
alter table public.orders add column if not exists shippo_parcel_audit_json jsonb;
alter table public.orders add column if not exists shippo_shipment_rates_json jsonb;
alter table public.orders add column if not exists shippo_shipment_rate_status text;
alter table public.orders add column if not exists shippo_shipment_sync_error text;
alter table public.orders add column if not exists shippo_parcels_override_json jsonb;

comment on column public.orders.shippo_shipment_object_id is 'Shippo Shipment object_id (POST /shipments/) for rating/labels.';
comment on column public.orders.shippo_parcel_audit_json is 'Computed parcel plan + audit trail (dims, pack keys, source). May include lastShipmentCreateRequest + lastShipmentCreateRequestAt (exact POST /shipments/ body last sent).';
comment on column public.orders.shippo_shipment_rates_json is 'Normalized Shippo rates from shipment create.';
comment on column public.orders.shippo_shipment_rate_status is 'e.g. rates_available | no_rates | error';
comment on column public.orders.shippo_shipment_sync_error is 'Last error creating/updating Shippo shipment.';
comment on column public.orders.shippo_parcels_override_json is 'Optional admin override: { parcels: [...] } replaces computed parcels until cleared.';

create index if not exists orders_shippo_shipment_object_id_idx
  on public.orders (shippo_shipment_object_id)
  where shippo_shipment_object_id is not null;

-- --- Label purchase (from patch-orders-shippo-label.sql) ---
alter table public.orders add column if not exists shippo_selected_rate_object_id text;
alter table public.orders add column if not exists shippo_label_url text;
alter table public.orders add column if not exists shippo_label_carrier text;
alter table public.orders add column if not exists shippo_label_service text;
alter table public.orders add column if not exists shippo_transaction_status text;
alter table public.orders add column if not exists shippo_tracking_url_provider text;
alter table public.orders add column if not exists shippo_label_purchased_at timestamptz;
alter table public.orders add column if not exists shippo_label_sync_error text;

comment on column public.orders.shippo_selected_rate_object_id is 'Shippo Rate object_id used for POST /transactions/';
comment on column public.orders.shippo_label_url is 'PDF/PNG label URL from successful transaction.';
comment on column public.orders.shippo_label_carrier is 'Carrier name at purchase (e.g. UPS).';
comment on column public.orders.shippo_label_service is 'Service level name at purchase.';
comment on column public.orders.shippo_transaction_status is 'Shippo transaction status (SUCCESS, ERROR, …).';
comment on column public.orders.shippo_tracking_url_provider is 'Carrier tracking page URL from transaction.';
comment on column public.orders.shippo_label_purchased_at is 'When label purchase completed.';
comment on column public.orders.shippo_label_sync_error is 'Last label purchase error message.';

-- --- Optional debug (from patch-orders-shippo-debug-columns.sql) ---
alter table public.orders add column if not exists shippo_last_attempt_payload jsonb;
alter table public.orders add column if not exists shippo_last_error_response jsonb;

comment on column public.orders.shippo_last_attempt_payload is 'Last JSON body sent to Shippo POST /orders/ (for debugging failed syncs).';
comment on column public.orders.shippo_last_error_response is 'Last parsed JSON error body from Shippo on failed sync.';

-- --- Ship / pickup date for Shippo POST /shipments/ (patch-orders-shippo-shipment-date.sql) ---
alter table public.orders add column if not exists shippo_shipment_date text;

comment on column public.orders.shippo_shipment_date is 'Calendar date YYYY-MM-DD for carrier tender / pickup; sent to Shippo as shipment_date when creating the shipment.';

-- Refresh PostgREST / Supabase API schema cache
notify pgrst, 'reload schema';
