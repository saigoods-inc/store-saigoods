-- Campaign-neutral one-time discount codes (run in Supabase SQL Editor).
-- Checkout uses the service role; staff read via RLS below.

create table if not exists public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  is_used boolean not null default false,
  used_at timestamptz,
  used_by_order_id text,
  created_at timestamptz not null default now()
);

create index if not exists discount_codes_is_used_idx on public.discount_codes (is_used);

comment on table public.discount_codes is 'One-time campaign promo codes; claimed atomically at checkout.';

alter table public.discount_codes enable row level security;

drop policy if exists "Staff read discount codes" on public.discount_codes;
create policy "Staff read discount codes"
  on public.discount_codes
  for select
  to authenticated
  using (true);

grant select on public.discount_codes to authenticated;

-- Create codes per campaign from Admin v2.5 instead of seeding a location-specific batch.
