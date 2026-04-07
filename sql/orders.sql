-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Required for checkout + Square webhooks.
-- After this, run orders_nexus_tax.sql for reporting columns + RPCs (or merge manually).

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null unique,
  status text not null default 'pending',
  order_status text not null default 'awaiting_payment'
    check (order_status in ('awaiting_payment', 'paid', 'ready_to_ship', 'shipped', 'cancelled')),
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_address text,
  items jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  shipping_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  provider text not null default 'square',
  payment_id text,
  state text,
  amount integer not null default 0,
  tax_collected integer not null default 0,
  created_at timestamptz not null default now()
);

comment on column public.orders.amount is 'Pretax order total (subtotal + shipping), cents.';
comment on column public.orders.tax_collected is 'Sales tax collected, cents (TN nexus).';
comment on column public.orders.state is 'Shipping destination state, 2-letter US.';

create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_customer_email_idx on public.orders (customer_email);
create index if not exists orders_state_idx on public.orders (state);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

alter table public.orders enable row level security;

-- Service role bypasses RLS; no policies needed for server-only access via SUPABASE_SERVICE_ROLE_KEY.
