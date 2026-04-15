-- Optional: last Shippo sync attempt details for admin debugging (safe to run multiple times).
alter table public.orders add column if not exists shippo_last_attempt_payload jsonb;
alter table public.orders add column if not exists shippo_last_error_response jsonb;

comment on column public.orders.shippo_last_attempt_payload is 'Last JSON body sent to Shippo POST /orders/ (for debugging failed syncs).';
comment on column public.orders.shippo_last_error_response is 'Last parsed JSON error body from Shippo on failed sync.';
