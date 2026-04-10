-- Hardin County one-time discount codes (run in Supabase SQL Editor).
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

comment on table public.discount_codes is 'One-time Hardin County TN promo codes; claimed atomically at checkout.';

alter table public.discount_codes enable row level security;

drop policy if exists "Staff read discount codes" on public.discount_codes;
create policy "Staff read discount codes"
  on public.discount_codes
  for select
  to authenticated
  using (true);

grant select on public.discount_codes to authenticated;

-- 60 unique codes (format HC-XXXXX). Regenerate if you need a fresh batch.
insert into public.discount_codes (code) values
  ('HC-E54PZ'),
  ('HC-YP4JB'),
  ('HC-PDEN6'),
  ('HC-7AE7E'),
  ('HC-H47GP'),
  ('HC-82DC4'),
  ('HC-7NFDF'),
  ('HC-753DF'),
  ('HC-8CJHJ'),
  ('HC-R7X28'),
  ('HC-ZQNCU'),
  ('HC-U42G6'),
  ('HC-6W5V7'),
  ('HC-NWKL6'),
  ('HC-2EPXE'),
  ('HC-8AEAG'),
  ('HC-HCJ2P'),
  ('HC-HM24M'),
  ('HC-M5K4J'),
  ('HC-S985V'),
  ('HC-YV9F5'),
  ('HC-CB6VM'),
  ('HC-8J2CX'),
  ('HC-75ALK'),
  ('HC-9FAT6'),
  ('HC-F3LRG'),
  ('HC-MQXR8'),
  ('HC-YPCZN'),
  ('HC-EVRCF'),
  ('HC-2SLAR'),
  ('HC-WGV7H'),
  ('HC-9VS77'),
  ('HC-S7RDN'),
  ('HC-ZDQGX'),
  ('HC-RT3U3'),
  ('HC-G8TAJ'),
  ('HC-HMDRZ'),
  ('HC-LPN2N'),
  ('HC-RVBMW'),
  ('HC-VWRNR'),
  ('HC-M4MHK'),
  ('HC-TELQY'),
  ('HC-BE9PP'),
  ('HC-LH3EC'),
  ('HC-MFZR5'),
  ('HC-5DHTG'),
  ('HC-5GJRZ'),
  ('HC-GRHSE'),
  ('HC-TVLRE'),
  ('HC-EQJMY'),
  ('HC-FZ6BV'),
  ('HC-9UFCB'),
  ('HC-YBJ4G'),
  ('HC-P4JB3'),
  ('HC-P3SEP'),
  ('HC-E2URL'),
  ('HC-6HJJ2'),
  ('HC-Z37FH'),
  ('HC-H2SM6'),
  ('HC-SAMP7')
on conflict (code) do nothing;

