-- Estimated-at-order and actual-at-settlement Square processing fees.
alter table public.orders add column if not exists estimated_processing_fee_cents integer check (estimated_processing_fee_cents >= 0);
alter table public.orders add column if not exists actual_processing_fee_cents integer check (actual_processing_fee_cents >= 0);
alter table public.orders add column if not exists processing_fee_status text not null default 'estimated'
  check (processing_fee_status in ('estimated', 'awaiting_square', 'actual', 'adjusted', 'reconciliation_failed'));
alter table public.orders add column if not exists processing_fee_profile text;
alter table public.orders add column if not exists processing_fee_synced_at timestamptz;
alter table public.orders add column if not exists processing_fee_details_json jsonb;

comment on column public.orders.estimated_processing_fee_cents is 'Frozen fee estimate from the active payment profile when the order was created.';
comment on column public.orders.actual_processing_fee_cents is 'Authoritative Square processing fee from Payment.processing_fee when available.';
comment on column public.orders.processing_fee_status is 'estimated | awaiting_square | actual | adjusted | reconciliation_failed.';
comment on column public.orders.processing_fee_details_json is 'Fee profile snapshot or raw Square processing-fee components; never card data.';
