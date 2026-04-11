-- Walk-in (cash/check) orders + receipt metadata. Run in Supabase SQL Editor (idempotent).

alter table public.orders add column if not exists order_type text not null default 'online';
comment on column public.orders.order_type is 'online | manual | walk_in — how the order was created.';

update public.orders
set order_type = case
  when trim(coalesce(order_source, 'web')) = 'manual' then 'manual'
  when trim(coalesce(order_source, 'web')) = 'walk_in' then 'walk_in'
  else 'online'
end;

alter table public.orders add column if not exists payment_method text;
comment on column public.orders.payment_method is 'cash | check for walk-in; null for card/Square.';

alter table public.orders add column if not exists paid_at timestamptz;
comment on column public.orders.paid_at is 'When payment was recorded (Square webhook or walk-in mark paid).';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_order_type_check'
  ) then
    alter table public.orders
      add constraint orders_order_type_check
      check (order_type in ('online', 'manual', 'walk_in'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_payment_method_check'
  ) then
    alter table public.orders
      add constraint orders_payment_method_check
      check (payment_method is null or payment_method in ('cash', 'check'));
  end if;
end $$;

alter table public.orders drop constraint if exists orders_order_source_check;
alter table public.orders add constraint orders_order_source_check
  check (order_source in ('web', 'manual', 'walk_in'));

comment on column public.orders.order_source is 'web | manual | walk_in — channel / origin.';
