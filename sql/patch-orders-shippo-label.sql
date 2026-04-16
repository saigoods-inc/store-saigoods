-- Label purchase + selected rate (Transaction API). Safe to run multiple times.

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
