-- Merchandise economics snapshot at quote time (admin P/L reporting).
alter table public.orders add column if not exists merchandise_list_subtotal_cents integer;
alter table public.orders add column if not exists merchandise_discount_loss_cents integer;
alter table public.orders add column if not exists expected_profit_cents integer;
alter table public.orders add column if not exists built_in_shipping_allowance_cents integer;

comment on column public.orders.merchandise_list_subtotal_cents is 'Merchandise subtotal at standard list bundle prices when the order was saved (cents).';
comment on column public.orders.merchandise_discount_loss_cents is 'max(0, list merchandise subtotal - actual merchandise subtotal) at save time; Hardin / tier deltas (cents).';
comment on column public.orders.expected_profit_cents is 'Sum of bundle expectedProfitCents × qty from catalog at save time (cents).';
comment on column public.orders.built_in_shipping_allowance_cents is 'Sum of bundle built-in shipping allowance totals × qty at save time (cents).';
