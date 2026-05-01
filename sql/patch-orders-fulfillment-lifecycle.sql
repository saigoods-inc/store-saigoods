-- Manual (staff) order fulfillment: carrier vs pickup vs local, and whether to quote shipping / use Shippo labels.
-- Future: quote logic keys off shipping_required; label / sync keys off shippo_label_required; routing keys off fulfillment_method.
-- Safe to re-run; does not modify existing row data.

alter table public.orders
  add column if not exists fulfillment_method text,
  add column if not exists shipping_required boolean,
  add column if not exists shippo_label_required boolean;

comment on column public.orders.fulfillment_method is
  'Intended delivery channel for manual orders: carrier, pickup, local_delivery (app-defined).';
comment on column public.orders.shipping_required is
  'If true, order includes shipped goods / shipping quote; future no-shipping orders will set false.';
comment on column public.orders.shippo_label_required is
  'If true, fulfillment expects Shippo / carrier label flow; future pickup-only may set false.';

notify pgrst, 'reload schema';
