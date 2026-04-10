-- Manual / phone orders: draft → payment link → paid (run in Supabase SQL Editor).

alter table public.orders add column if not exists order_source text not null default 'web';
comment on column public.orders.order_source is 'web | manual';

alter table public.orders add column if not exists shipping_address jsonb;
comment on column public.orders.shipping_address is 'Structured ship-to for manual orders (line1, city, state, postalCode, …).';

alter table public.orders add column if not exists payment_link_url text;
comment on column public.orders.payment_link_url is 'Square Online Checkout payment link URL when staff emailed the customer.';

alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (
    order_status in (
      'draft',
      'payment_link_sent',
      'awaiting_payment',
      'paid',
      'ready_to_ship',
      'shipped',
      'cancelled'
    )
  );
