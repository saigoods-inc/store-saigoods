-- Per-package Shippo labels (Approach B: one Shippo shipment + one label per physical package).
-- public.orders.id is bigint in this project — order_shippo_labels.order_id must be bigint.
-- Safe to re-run: IF NOT EXISTS / DROP IF EXISTS / only drop table when empty and wrong type.
-- After apply: NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 0) If a previous failed/mistyped migration created order_shippo_labels with uuid
--    order_id, remove it when empty so we can recreate. (If non-empty, fix manually.)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.order_shippo_labels') is not null then
    if exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'order_shippo_labels'
        and c.column_name = 'order_id'
        and c.data_type = 'uuid'
    ) then
      if (select count(*)::bigint from public.order_shippo_labels) = 0 then
        raise notice 'Dropping public.order_shippo_labels (order_id was uuid, table empty) to fix schema.';
        drop table public.order_shippo_labels cascade;
      else
        raise exception
          'public.order_shippo_labels has uuid order_id and contains rows. Backup/truncate, then re-run, or fix column type manually to bigint.';
      end if;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1) Child table: one row per parcel / label (order_id = bigint, matches orders.id)
-- ---------------------------------------------------------------------------
create table if not exists public.order_shippo_labels (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null,
  parcel_index integer not null,
  parcel_count integer not null,
  parcel_metadata jsonb,
  shipment_object_id text,
  selected_rate_object_id text,
  transaction_id text,
  label_url text,
  tracking_number text,
  tracking_url text,
  carrier text,
  servicelevel_token text,
  servicelevel_name text,
  amount_cents integer,
  currency text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'purchased', 'failed', 'skipped')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- FK: add only if not present (re-run safe; works when table was created on first run without FK for partial scripts)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_shippo_labels_order_id_fkey'
  ) then
    alter table public.order_shippo_labels
      add constraint order_shippo_labels_order_id_fkey
      foreign key (order_id) references public.orders (id) on delete cascade;
  end if;
end
$$;

create unique index if not exists order_shippo_labels_order_parcel_uidx
  on public.order_shippo_labels (order_id, parcel_index);
create index if not exists order_shippo_labels_order_id_idx on public.order_shippo_labels (order_id);
create index if not exists order_shippo_labels_status_idx on public.order_shippo_labels (status);

comment on table public.order_shippo_labels is
  'One Shippo label per physical package; created by admin multi-label purchase flow.';

-- ---------------------------------------------------------------------------
-- 2) Fulfillment: partial / complete multi-label (extends staff workflow)
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (
    order_status in (
      'draft',
      'payment_link_sent',
      'awaiting_payment',
      'paid',
      'ready_to_ship',
      'partial_label_purchase',
      'label_purchased',
      'shipped',
      'cancelled'
    )
  );

-- ---------------------------------------------------------------------------
-- 3) RLS: staff (authenticated) can read; writes go through service role in API
-- ---------------------------------------------------------------------------
alter table public.order_shippo_labels enable row level security;

drop policy if exists "Staff can read order_shippo_labels" on public.order_shippo_labels;
create policy "Staff can read order_shippo_labels"
  on public.order_shippo_labels
  for select
  to authenticated
  using (true);

notify pgrst, 'reload schema';
