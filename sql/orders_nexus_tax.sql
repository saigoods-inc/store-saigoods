-- Run in Supabase SQL Editor after initial orders table exists.
-- Adds nexus / TN tax reporting columns and read-only aggregate RPCs for the service role.

alter table public.orders add column if not exists state text;
alter table public.orders add column if not exists amount integer not null default 0;
comment on column public.orders.amount is 'Order total before sales tax (subtotal + shipping), cents.';
alter table public.orders add column if not exists tax_collected integer not null default 0;
comment on column public.orders.tax_collected is 'Sales tax collected on this order, cents (TN only for now).';

-- Backfill from legacy columns where possible
update public.orders
set
  amount = coalesce(subtotal_cents, 0) + coalesce(shipping_cents, 0),
  tax_collected = coalesce(tax_cents, 0)
where (amount is null or amount = 0)
  and (coalesce(subtotal_cents, 0) + coalesce(shipping_cents, 0)) > 0;

create index if not exists orders_state_idx on public.orders (state);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_state_idx on public.orders (status, state);

-- Cumulative paid revenue + order count by destination state (nexus monitoring)
create or replace function public.nexus_summary()
returns table (
  state text,
  total_revenue bigint,
  total_orders bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(nullif(trim(o.state), ''), 'UNKNOWN') as state,
    coalesce(sum(o.amount), 0)::bigint as total_revenue,
    count(*)::bigint as total_orders
  from public.orders o
  where o.status = 'paid'
  group by 1
  order by 1;
$$;

-- TN-only: tax collected + taxable base by calendar month (UTC)
create or replace function public.tax_summary_tn()
returns table (
  month text,
  state text,
  taxable_revenue bigint,
  tax_collected bigint,
  total_orders bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    to_char(date_trunc('month', o.created_at at time zone 'UTC'), 'YYYY-MM') as month,
    'TN'::text as state,
    coalesce(sum(o.amount), 0)::bigint as taxable_revenue,
    coalesce(sum(o.tax_collected), 0)::bigint as tax_collected,
    count(*)::bigint as total_orders
  from public.orders o
  where o.status = 'paid'
    and o.state = 'TN'
  group by date_trunc('month', o.created_at at time zone 'UTC')
  order by 1 desc;
$$;

revoke all on function public.nexus_summary() from public;
revoke all on function public.tax_summary_tn() from public;
grant execute on function public.nexus_summary() to service_role;
grant execute on function public.tax_summary_tn() to service_role;
