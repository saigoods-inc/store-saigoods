-- Run in Supabase SQL Editor if you see errors about missing columns (e.g. `provider`).
-- Safe to run multiple times.

alter table public.orders add column if not exists provider text not null default 'square';
alter table public.orders add column if not exists payment_id text;
alter table public.orders add column if not exists created_at timestamptz not null default now();

-- If you created orders without defaults, backfill (optional):
-- update public.orders set provider = 'square' where provider is null;
