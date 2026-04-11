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

-- Staff manual order: track when local discount was applied via ZIP override (see /admin/manual-order).
alter table public.orders add column if not exists admin_local_discount_override boolean not null default false;

comment on column public.orders.admin_local_discount_override is
  'True when staff applied local (Hardin-tier) pricing despite shipping ZIP outside the normal eligible area.';

-- Last modified (manual “Save to update”, payment-link sync, etc.).
alter table public.orders add column if not exists updated_at timestamptz;

update public.orders set updated_at = created_at where updated_at is null;

alter table public.orders alter column updated_at set default now();

comment on column public.orders.updated_at is 'Row last update time; initialized from created_at for existing rows.';
