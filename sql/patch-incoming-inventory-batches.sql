-- Incoming inventory batches (containers / PO lines) — run in Supabase SQL Editor (rerunnable).
-- Phase A: persistence only; receiving does not mutate inventory_levels until a later phase.
-- Server reads/writes via service role only (see lib/incoming-inventory-batches.js).

create table if not exists public.incoming_inventory_batches (
  id uuid primary key default gen_random_uuid(),
  batch_name text not null,
  container_number text,
  po_number text,
  supplier text,
  eta_date date,
  arrival_date date,
  received_at timestamptz,
  cancelled_at timestamptz,
  status text not null default 'planned' check (
    status in ('planned', 'in_transit', 'arrived', 'received', 'cancelled')
  ),
  notes text,
  created_by text,
  updated_by text,
  received_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.incoming_inventory_batches is
  'Inbound shipment / batch metadata. Expected quantities live on incoming_inventory_batch_lines; physical stock increases only after receive is implemented and confirmed.';

create table if not exists public.incoming_inventory_batch_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.incoming_inventory_batches (id) on delete cascade,
  product_slug text not null,
  size text not null,
  expected_cases integer not null default 0 check (expected_cases >= 0),
  expected_boxes integer not null default 0 check (expected_boxes >= 0),
  received_cases integer not null default 0 check (received_cases >= 0),
  received_boxes integer not null default 0 check (received_boxes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint incoming_inventory_batch_lines_expected_nonzero check (
    expected_cases > 0 or expected_boxes > 0
  )
);

comment on table public.incoming_inventory_batch_lines is
  'Per-variant expected (and future received) case/box counts for an incoming batch.';

create index if not exists incoming_inventory_batches_status_idx
  on public.incoming_inventory_batches (status);

create index if not exists incoming_inventory_batches_eta_date_idx
  on public.incoming_inventory_batches (eta_date);

create index if not exists incoming_inventory_batches_container_number_idx
  on public.incoming_inventory_batches (container_number)
  where container_number is not null;

create index if not exists incoming_inventory_batches_po_number_idx
  on public.incoming_inventory_batches (po_number)
  where po_number is not null;

create index if not exists incoming_inventory_batch_lines_batch_id_idx
  on public.incoming_inventory_batch_lines (batch_id);

create index if not exists incoming_inventory_batch_lines_slug_size_idx
  on public.incoming_inventory_batch_lines (product_slug, size);

grant select, insert, update, delete on table public.incoming_inventory_batches to service_role;
grant select, insert, update, delete on table public.incoming_inventory_batch_lines to service_role;
