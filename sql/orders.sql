-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Required for checkout + Square webhooks.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null unique,
  status text not null default 'pending',
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
  created_at timestamptz not null default now()
);

create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_customer_email_idx on public.orders (customer_email);

alter table public.orders enable row level security;

-- Service role bypasses RLS; no policies needed for server-only access via SUPABASE_SERVICE_ROLE_KEY.
