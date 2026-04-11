-- Run in Supabase SQL Editor if you see errors about missing columns (e.g. `provider`).
-- Safe to run multiple times.

alter table public.orders add column if not exists provider text not null default 'square';
alter table public.orders add column if not exists payment_id text;
alter table public.orders add column if not exists created_at timestamptz not null default now();
alter table public.orders add column if not exists updated_at timestamptz default now();
update public.orders set updated_at = created_at where updated_at is null;
alter table public.orders add column if not exists order_ref text;

-- If order_ref was added nullable, backfill then enforce NOT NULL (run once after backfill):
-- update public.orders set order_ref = 'SAI-' || replace(gen_random_uuid()::text, '-', '') where order_ref is null;
-- alter table public.orders alter column order_ref set not null;
-- create unique index if not exists orders_order_ref_key on public.orders (order_ref);

-- If you created orders without defaults, backfill (optional):
-- update public.orders set provider = 'square' where provider is null;
