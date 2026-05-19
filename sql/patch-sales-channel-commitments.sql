-- Multi-channel committed demand (Amazon FBM, etc.) — run in Supabase SQL Editor (rerunnable).
-- Server reads/writes via service role only (see lib/sales-channel-commitments.js).

create table if not exists public.sales_channel_commitments (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  external_order_id text,
  product_slug text not null,
  size text not null,
  quantity_cases integer not null default 0 check (quantity_cases >= 0),
  quantity_boxes integer not null default 0 check (quantity_boxes >= 0),
  status text not null default 'unshipped' check (status in ('unshipped', 'shipped', 'cancelled')),
  sold_at timestamptz,
  shipped_at timestamptz,
  notes text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_channel_commitments_qty_nonzero check (quantity_cases > 0 or quantity_boxes > 0)
);

comment on table public.sales_channel_commitments is
  'External / marketplace sold-unshipped demand (cases + boxes per catalog line). Not decremented from inventory_levels until fulfillment workflow says so.';

create index if not exists sales_channel_commitments_channel_status_idx
  on public.sales_channel_commitments (channel, status);

create index if not exists sales_channel_commitments_slug_size_idx
  on public.sales_channel_commitments (product_slug, size);

create index if not exists sales_channel_commitments_external_order_idx
  on public.sales_channel_commitments (external_order_id)
  where external_order_id is not null;

create index if not exists sales_channel_commitments_sold_at_idx
  on public.sales_channel_commitments (sold_at desc nulls last);

grant select, insert, update, delete on table public.sales_channel_commitments to service_role;
