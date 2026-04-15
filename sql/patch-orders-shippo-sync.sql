-- Shippo order linkage + webhook idempotency support.
-- Safe to run multiple times.

alter table public.orders add column if not exists shippo_order_id text;
alter table public.orders add column if not exists shippo_sync_status text not null default 'pending';
alter table public.orders add column if not exists shippo_synced_at timestamptz;
alter table public.orders add column if not exists shippo_last_sync_at timestamptz;
alter table public.orders add column if not exists shippo_sync_error text;
alter table public.orders add column if not exists shippo_transaction_id text;
alter table public.orders add column if not exists shippo_shipment_status text;
alter table public.orders add column if not exists shippo_tracking_number text;
alter table public.orders add column if not exists shippo_tracking_status text;
alter table public.orders add column if not exists shippo_tracking_status_detail text;
alter table public.orders add column if not exists shippo_last_event_at timestamptz;

create unique index if not exists orders_shippo_order_id_uidx
  on public.orders (shippo_order_id)
  where shippo_order_id is not null;

create index if not exists orders_shippo_sync_status_idx on public.orders (shippo_sync_status);
create index if not exists orders_shippo_transaction_id_idx on public.orders (shippo_transaction_id);
create index if not exists orders_shippo_tracking_number_idx on public.orders (shippo_tracking_number);

create table if not exists public.shippo_webhook_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  event_type text,
  shippo_object_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists shippo_webhook_events_received_at_idx
  on public.shippo_webhook_events (received_at desc);
