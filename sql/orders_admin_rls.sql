-- Run in Supabase SQL Editor after orders table exists.
-- Adds fulfillment workflow column + RLS so authenticated staff can read/update orders from the admin UI.
-- Server-side checkout continues to use the service role (bypasses RLS).

-- 1) order_status: staff workflow (separate from payment field `status` which stays pending/paid)
alter table public.orders add column if not exists order_status text;

update public.orders
set order_status = case
  when coalesce(status, '') = 'paid' then 'paid'
  else 'awaiting_payment'
end
where order_status is null or trim(order_status) = '';

alter table public.orders alter column order_status set default 'awaiting_payment';
alter table public.orders alter column order_status set not null;

alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (
    order_status in (
      'awaiting_payment',
      'paid',
      'ready_to_ship',
      'shipped',
      'cancelled'
    )
  );

comment on column public.orders.order_status is
  'Fulfillment workflow for staff. Payment lifecycle remains in `status` (pending/paid).';

-- 2) RLS: staff (logged-in Supabase users) can list orders and update rows (admin UI only sends order_status)
drop policy if exists "Staff can read orders" on public.orders;
create policy "Staff can read orders"
  on public.orders
  for select
  to authenticated
  using (true);

drop policy if exists "Staff can update orders" on public.orders;
create policy "Staff can update orders"
  on public.orders
  for update
  to authenticated
  using (true)
  with check (true);

-- Inserts remain service-role only (no insert policy for anon/authenticated).

grant select, update on public.orders to authenticated;
