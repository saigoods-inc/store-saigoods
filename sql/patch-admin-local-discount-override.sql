-- Optional standalone patch (idempotent). The same DDL is included in sql/patch-manual-orders.sql.
-- Run in Supabase SQL Editor if you already applied patch-manual-orders.sql before this column existed.

alter table public.orders add column if not exists admin_local_discount_override boolean not null default false;

comment on column public.orders.admin_local_discount_override is
  'True when staff chose to apply local discount despite ineligible shipping ZIP (manual orders only).';
