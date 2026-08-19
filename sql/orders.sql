-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Required for checkout + Square webhooks.
-- After this, run orders_nexus_tax.sql for reporting columns + RPCs (or merge manually).

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null unique,
  status text not null default 'pending',
  order_status text not null default 'awaiting_payment'
    check (
      order_status in (
        'draft',
        'payment_link_sent',
        'awaiting_payment',
        'paid',
        'ready_to_ship',
        'shipped',
        'cancelled'
      )
    ),
  order_source text not null default 'web',
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_address text,
  shipping_address jsonb,
  payment_link_url text,
  items jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  shipping_cents integer not null default 0,
  paid_shipping_amount_cents integer not null default 0,
  quoted_shipping_mode text,
  quoted_shipping_status text,
  quoted_shipping_amount_cents integer not null default 0,
  quoted_shipping_base_amount_cents integer not null default 0,
  quoted_shipping_buffer_cents integer not null default 0,
  quoted_shipping_residential_surcharge_cents integer not null default 0,
  quoted_shipping_total_cents integer not null default 0,
  quoted_shipping_service_code text,
  quoted_shipping_service_label text,
  quoted_shipping_currency text,
  quoted_shipping_provider text,
  quoted_shipping_provider_quote_id text,
  quoted_taxable_shipping_cents integer not null default 0,
  quoted_parcel_summary_json jsonb,
  quoted_address_snapshot_json jsonb,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  provider text not null default 'square',
  payment_id text,
  estimated_processing_fee_cents integer check (estimated_processing_fee_cents >= 0),
  actual_processing_fee_cents integer check (actual_processing_fee_cents >= 0),
  processing_fee_status text not null default 'estimated'
    check (processing_fee_status in ('estimated', 'awaiting_square', 'actual', 'adjusted', 'reconciliation_failed')),
  processing_fee_profile text,
  processing_fee_synced_at timestamptz,
  processing_fee_details_json jsonb,
  checkout_attempt_id uuid unique,
  inventory_committed_at timestamptz,
  payment_reconciliation_required boolean not null default false,
  payment_reconciliation_error text,
  vendor_paid_notification_claimed_at timestamptz,
  vendor_paid_notification_sent_at timestamptz,
  vendor_paid_notification_resend_id text,
  vendor_paid_notification_error text,
  state text,
  amount integer not null default 0,
  tax_collected integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.orders.amount is 'Pretax order total (subtotal + shipping), cents.';
comment on column public.orders.tax_collected is 'Sales tax collected, cents (TN nexus).';
comment on column public.orders.paid_shipping_amount_cents is 'Shipping amount charged to customer at payment finalization; keep shipping_cents mirrored during transition.';
comment on column public.orders.quoted_shipping_mode is 'Quote shipping mode snapshot (e.g. baked_in, live_ups).';
comment on column public.orders.quoted_shipping_status is 'Quote shipping status snapshot (e.g. quoted, included_in_merchandise, invalid_address).';
comment on column public.orders.quoted_shipping_amount_cents is 'Customer-facing carrier line in cents (may include buffer; see quoted_shipping_base_amount_cents).';
comment on column public.orders.quoted_shipping_base_amount_cents is 'Provider-quoted line before buffer, cents.';
comment on column public.orders.quoted_shipping_buffer_cents is 'Cents added at quote time (e.g. SHIPPING_BUFFER_CENTS).';
comment on column public.orders.quoted_shipping_residential_surcharge_cents is 'Quoted residential surcharge, cents.';
comment on column public.orders.quoted_shipping_total_cents is 'Quoted shipping + residential surcharge, cents.';
comment on column public.orders.quoted_shipping_service_code is 'Quoted carrier service code.';
comment on column public.orders.quoted_shipping_service_label is 'Quoted carrier service display label.';
comment on column public.orders.quoted_shipping_currency is 'Quoted shipping currency (USD).';
comment on column public.orders.quoted_shipping_provider is 'Quoted shipping provider identifier (e.g. ups).';
comment on column public.orders.quoted_shipping_provider_quote_id is 'Provider quote/rate identifier captured at quote time.';
comment on column public.orders.quoted_taxable_shipping_cents is 'Quoted shipping amount that is taxable, cents.';
comment on column public.orders.quoted_parcel_summary_json is 'Quoted parcel planning snapshot used for shipping quote.';
comment on column public.orders.quoted_address_snapshot_json is 'Quoted ship-to snapshot (input + normalized/validated shape).';
comment on column public.orders.vendor_paid_notification_claimed_at is
  'When a Square webhook worker claimed the right to send the vendor paid-order email; cleared after send or release. Stale claims may be reclaimed.';
comment on column public.orders.vendor_paid_notification_sent_at is
  'When the vendor paid-order notification was successfully sent via Resend; null until first successful send.';
comment on column public.orders.vendor_paid_notification_resend_id is
  'Resend email id returned after a successful vendor paid-order notification send.';
comment on column public.orders.vendor_paid_notification_error is
  'Safe, length-limited summary of the last vendor notification failure after a released claim; not secrets or raw provider payloads.';
comment on column public.orders.state is 'Shipping destination state, 2-letter US.';
comment on column public.orders.updated_at is 'Last row update (draft saves, payment link, etc.).';
comment on column public.orders.checkout_attempt_id is 'Browser-generated online checkout attempt id. Unique so payment retries reuse one order and one Square idempotency key.';
comment on column public.orders.inventory_committed_at is 'When inventory was atomically committed for this order.';
comment on column public.orders.payment_reconciliation_required is 'True when Square reported payment but local paid-order finalization needs review.';

create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_customer_email_idx on public.orders (customer_email);
create index if not exists orders_state_idx on public.orders (state);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

alter table public.orders enable row level security;

-- Service role bypasses RLS; no policies needed for server-only access via SUPABASE_SERVICE_ROLE_KEY.
