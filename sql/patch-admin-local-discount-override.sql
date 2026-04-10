-- Manual orders: staff may force local (Hardin-tier) pricing when ZIP is outside the eligible area.
-- Run in Supabase SQL Editor after `orders` exists.

alter table public.orders add column if not exists admin_local_discount_override boolean not null default false;

comment on column public.orders.admin_local_discount_override is
  'True when staff chose to apply local discount despite ineligible shipping ZIP (manual orders only).';
