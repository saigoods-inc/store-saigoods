-- Shipment + parcel audit (rates, label purchase prep). Safe to run multiple times.

alter table public.orders add column if not exists shippo_shipment_object_id text;
alter table public.orders add column if not exists shippo_parcel_audit_json jsonb;
alter table public.orders add column if not exists shippo_shipment_rates_json jsonb;
alter table public.orders add column if not exists shippo_shipment_rate_status text;
alter table public.orders add column if not exists shippo_shipment_sync_error text;
alter table public.orders add column if not exists shippo_parcels_override_json jsonb;

comment on column public.orders.shippo_shipment_object_id is 'Shippo Shipment object_id (POST /shipments/) for rating/labels.';
comment on column public.orders.shippo_parcel_audit_json is 'Computed parcel plan + audit trail (dims, pack keys, source).';
comment on column public.orders.shippo_shipment_rates_json is 'Subset of Shippo rates[] returned on shipment create.';
comment on column public.orders.shippo_shipment_rate_status is 'e.g. rates_available | no_rates | error';
comment on column public.orders.shippo_shipment_sync_error is 'Last error creating/updating Shippo shipment.';
comment on column public.orders.shippo_parcels_override_json is 'Optional admin override: { parcels: [...] } replaces computed parcels until cleared.';

create index if not exists orders_shippo_shipment_object_id_idx
  on public.orders (shippo_shipment_object_id)
  where shippo_shipment_object_id is not null;
