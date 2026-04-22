-- Inventory persistence for SAI Goods (Supabase Postgres)
-- Run once in Supabase SQL editor (or via migration pipeline).
--
-- Env (Vercel / server): INVENTORY_BACKEND=supabase
-- Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only; never expose to browser)

-- Extensions
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_active_idx on public.products (active) where active = true;

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  size_label text not null,
  sku text,
  boxes_per_case int not null default 10 check (boxes_per_case > 0),
  gloves_per_box int check (gloves_per_box is null or gloves_per_box > 0),
  track_inventory boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, size_label)
);

create index if not exists product_variants_product_id_idx on public.product_variants (product_id);
create index if not exists product_variants_size_idx on public.product_variants (size_label);

create table if not exists public.inventory_levels (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null unique references public.product_variants (id) on delete cascade,
  cases_on_hand int not null default 0 check (cases_on_hand >= 0),
  boxes_loose_on_hand int not null default 0 check (boxes_loose_on_hand >= 0),
  cases_baseline int check (cases_baseline is null or cases_baseline >= 0),
  boxes_baseline int check (boxes_baseline is null or boxes_baseline >= 0),
  incoming_cases int not null default 0 check (incoming_cases >= 0),
  incoming_boxes int not null default 0 check (incoming_boxes >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_levels_variant_id_idx on public.inventory_levels (variant_id);
create index if not exists inventory_levels_updated_at_idx on public.inventory_levels (updated_at);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  movement_type text not null check (
    movement_type in (
      'initial_stock',
      'manual_adjustment',
      'restock',
      'order_commit',
      'order_cancel_restock',
      'walk_in_sale',
      'non_web_shipment',
      'receive_shipment',
      'admin_set',
      'other'
    )
  ),
  cases_delta int not null default 0,
  boxes_delta int not null default 0,
  note text,
  reference_type text,
  reference_id text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_variant_id_idx on public.inventory_movements (variant_id);
create index if not exists inventory_movements_created_at_idx on public.inventory_movements (created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security (recommendations)
-- ---------------------------------------------------------------------------
-- This codebase uses the Supabase service role only on the server (API routes). You may:
--   * leave RLS disabled (simplest), or
--   * enable RLS and add policies for any future direct client access.
-- Service role bypasses RLS on Supabase; do not expose the service key to the browser.

-- ---------------------------------------------------------------------------
-- Atomic batch apply: updates levels + inserts one movement row per op.
-- Each op: { "variant_id": "<uuid>", "cases_delta": int, "boxes_delta": int,
--            "movement_type": "...", "note": "...", "reference_type": "...", "reference_id": "...", "created_by": "..." }
-- ---------------------------------------------------------------------------

create or replace function public.inventory_apply_ops(p_ops jsonb)
returns void
language plpgsql
as $$
declare
  op jsonb;
  vid uuid;
  dc int;
  db int;
  mt text;
  cur_cases int;
  cur_boxes int;
  new_cases int;
  new_boxes int;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'p_ops must be a jsonb array';
  end if;

  for op in select * from jsonb_array_elements(p_ops)
  loop
    vid := (op->>'variant_id')::uuid;
    dc := coalesce((op->>'cases_delta')::int, 0);
    db := coalesce((op->>'boxes_delta')::int, 0);
    mt := coalesce(op->>'movement_type', 'other');

    if dc = 0 and db = 0 then
      continue;
    end if;

    select cases_on_hand, boxes_loose_on_hand
      into cur_cases, cur_boxes
    from public.inventory_levels
    where variant_id = vid
    for update;

    if not found then
      raise exception 'inventory_levels row not found for variant %', vid;
    end if;

    new_cases := cur_cases + dc;
    new_boxes := cur_boxes + db;

    if new_cases < 0 or new_boxes < 0 then
      raise exception 'negative stock for variant % (cases % -> %, boxes % -> %)',
        vid, cur_cases, new_cases, cur_boxes, new_boxes;
    end if;

    update public.inventory_levels
      set cases_on_hand = new_cases,
          boxes_loose_on_hand = new_boxes,
          updated_at = now()
    where variant_id = vid;

    insert into public.inventory_movements (
      variant_id,
      movement_type,
      cases_delta,
      boxes_delta,
      note,
      reference_type,
      reference_id,
      created_by
    ) values (
      vid,
      mt,
      dc,
      db,
      nullif(op->>'note', ''),
      nullif(op->>'reference_type', ''),
      nullif(op->>'reference_id', ''),
      nullif(op->>'created_by', '')
    );
  end loop;
end;
$$;

grant execute on function public.inventory_apply_ops(jsonb) to service_role;
