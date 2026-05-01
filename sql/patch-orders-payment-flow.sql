-- First-class payment flow for manual (staff) orders (Square link, pay later, in-person, etc.).
-- Application code also infers "square payment link" from payment_link_url when payment_flow is null.
-- Safe to re-run; does not modify existing row data.

alter table public.orders
  add column if not exists payment_flow text,
  add column if not exists manual_payment_method text,
  add column if not exists manual_payment_recorded_at timestamptz,
  add column if not exists manual_payment_recorded_by text;

comment on column public.orders.payment_flow is
  'How the manual order is meant to be paid, e.g. square_payment_link, pay_later (see app).';
comment on column public.orders.manual_payment_method is
  'For in-person or recorded manual payments, e.g. cash, check (set when staff records payment; future).';
comment on column public.orders.manual_payment_recorded_at is
  'When staff recorded a non-Square payment (future).';
comment on column public.orders.manual_payment_recorded_by is
  'Identifier for staff who recorded a manual payment (e.g. email; future).';

notify pgrst, 'reload schema';
