-- Marketplace seller-fulfilled orders (Amazon FBM and Walmart). Apply before deploying the endpoint.
-- A shipment transition is atomic and idempotently decrements physical inventory exactly once.
create table if not exists public.marketplace_orders (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null check (marketplace in ('amazon', 'walmart')),
  external_order_id text not null,
  status text not null default 'new' check (status in ('new', 'packed', 'shipped', 'cancelled')),
  sold_at timestamptz,
  packed_at timestamptz,
  shipped_at timestamptz,
  inventory_committed_at timestamptz,
  notes text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marketplace, external_order_id)
);

alter table public.marketplace_orders add column if not exists inventory_committed_at timestamptz;
alter table public.marketplace_orders add column if not exists currency text not null default 'USD';
alter table public.marketplace_orders add column if not exists merchandise_subtotal_cents integer not null default 0 check (merchandise_subtotal_cents >= 0);
alter table public.marketplace_orders add column if not exists shipping_charged_cents integer not null default 0 check (shipping_charged_cents >= 0);
alter table public.marketplace_orders add column if not exists discount_cents integer not null default 0 check (discount_cents >= 0);
alter table public.marketplace_orders add column if not exists tax_collected_cents integer not null default 0 check (tax_collected_cents >= 0);
alter table public.marketplace_orders add column if not exists marketplace_fee_cents integer not null default 0 check (marketplace_fee_cents >= 0);
alter table public.marketplace_orders add column if not exists payment_processing_fee_cents integer not null default 0 check (payment_processing_fee_cents >= 0);
alter table public.marketplace_orders add column if not exists shipping_cost_cents integer not null default 0 check (shipping_cost_cents >= 0);
alter table public.marketplace_orders add column if not exists other_cost_cents integer not null default 0 check (other_cost_cents >= 0);
alter table public.marketplace_orders add column if not exists refund_cents integer not null default 0 check (refund_cents >= 0);
alter table public.marketplace_orders add column if not exists net_payout_cents integer check (net_payout_cents >= 0);
alter table public.marketplace_orders add column if not exists financial_status text not null default 'estimated'
  check (financial_status in ('estimated', 'complete', 'partial_refund', 'refunded'));

-- Marketplace movements use the same ledger as website and walk-in orders.
alter table public.inventory_movements
  drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check check (
    movement_type in (
      'initial_stock', 'manual_adjustment', 'restock', 'order_commit',
      'order_cancel_restock', 'walk_in_sale', 'non_web_shipment',
      'receive_shipment', 'admin_set', 'marketplace_sale',
      'marketplace_cancelled', 'other'
    )
  );

create table if not exists public.marketplace_order_lines (
  id uuid primary key default gen_random_uuid(),
  marketplace_order_id uuid not null references public.marketplace_orders(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id),
  product_slug text not null,
  size text not null,
  quantity_cases integer not null default 0 check (quantity_cases >= 0),
  quantity_boxes integer not null default 0 check (quantity_boxes >= 0),
  constraint marketplace_order_lines_quantity_nonzero check (quantity_cases > 0 or quantity_boxes > 0)
);

alter table public.marketplace_order_lines add column if not exists unit_type text check (unit_type in ('case', 'box'));
alter table public.marketplace_order_lines add column if not exists unit_sale_price_cents integer check (unit_sale_price_cents >= 0);
alter table public.marketplace_order_lines add column if not exists unit_cost_cents integer check (unit_cost_cents >= 0);
alter table public.marketplace_order_lines add column if not exists line_revenue_cents integer check (line_revenue_cents >= 0);
alter table public.marketplace_order_lines add column if not exists line_cost_cents integer check (line_cost_cents >= 0);

create index if not exists marketplace_order_lines_order_idx on public.marketplace_order_lines (marketplace_order_id);

-- Consume requested units while preserving the physical carton/loose-box state.
-- Carton demand requires intact cartons. Box demand uses loose boxes first, then opens
-- the minimum number of cartons. The returned/ledger deltas are the exact physical
-- mutation, so cancellation can reverse an opened carton without guessing.
create or replace function public.inventory_consume_demands(p_demands jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  demand jsonb;
  v_id uuid;
  v_cases int;
  v_boxes int;
  v_bpc int;
  v_requested_cases int;
  v_requested_boxes int;
  v_next_cases int;
  v_next_boxes int;
  v_boxes_from_cases int;
  v_cases_to_open int;
  v_actual_op jsonb;
  v_actual_ops jsonb := '[]'::jsonb;
begin
  if p_demands is null or jsonb_typeof(p_demands) <> 'array' then
    raise exception 'p_demands must be a jsonb array' using errcode = 'P0001';
  end if;

  for demand in select value from jsonb_array_elements(p_demands) as t(value) loop
    v_id := (demand->>'variant_id')::uuid;
    v_requested_cases := greatest(0, coalesce((demand->>'quantity_cases')::int, 0));
    v_requested_boxes := greatest(0, coalesce((demand->>'quantity_boxes')::int, 0));
    if v_requested_cases = 0 and v_requested_boxes = 0 then continue; end if;

    select il.cases_on_hand, il.boxes_loose_on_hand, greatest(1, pv.boxes_per_case)
      into v_cases, v_boxes, v_bpc
    from public.inventory_levels il
    join public.product_variants pv on pv.id = il.variant_id
    where il.variant_id = v_id
    for update of il;

    if not found then
      raise exception 'inventory_levels row not found for variant %', v_id using errcode = 'P0001';
    end if;
    if v_requested_cases > v_cases then
      raise exception 'insufficient stock for variant % (cases %, boxes %, boxes_per_case %, requested_cases %, requested_boxes %)',
        v_id, v_cases, v_boxes, v_bpc, v_requested_cases, v_requested_boxes using errcode = 'P0001';
    end if;

    v_next_cases := v_cases - v_requested_cases;
    if v_requested_boxes <= v_boxes then
      v_next_boxes := v_boxes - v_requested_boxes;
    else
      v_boxes_from_cases := v_requested_boxes - v_boxes;
      v_cases_to_open := (v_boxes_from_cases + v_bpc - 1) / v_bpc;
      if v_cases_to_open > v_next_cases then
        raise exception 'insufficient stock for variant % (cases %, boxes %, boxes_per_case %, requested_cases %, requested_boxes %)',
          v_id, v_cases, v_boxes, v_bpc, v_requested_cases, v_requested_boxes using errcode = 'P0001';
      end if;
      v_next_cases := v_next_cases - v_cases_to_open;
      v_next_boxes := v_cases_to_open * v_bpc - v_boxes_from_cases;
    end if;

    v_actual_op := jsonb_build_object(
      'variant_id', v_id,
      'cases_delta', v_next_cases - v_cases,
      'boxes_delta', v_next_boxes - v_boxes,
      'movement_type', coalesce(nullif(demand->>'movement_type', ''), 'other'),
      'reference_type', nullif(demand->>'reference_type', ''),
      'reference_id', nullif(demand->>'reference_id', ''),
      'note', nullif(demand->>'note', ''),
      'created_by', nullif(demand->>'created_by', '')
    );
    perform public.inventory_apply_ops(jsonb_build_array(v_actual_op));
    v_actual_ops := v_actual_ops || jsonb_build_array(v_actual_op);
  end loop;
  return v_actual_ops;
end; $$;

drop function if exists public.marketplace_order_record(text, text, jsonb, timestamptz, text, text);

create or replace function public.marketplace_order_record(p_marketplace text, p_external_order_id text, p_lines jsonb, p_financials jsonb, p_sold_at timestamptz default null, p_notes text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.marketplace_orders%rowtype; item jsonb; v_id uuid; v_slug text; v_size text; v_cases int; v_boxes int; v_ops jsonb := '[]'::jsonb; v_merchandise int := 0;
begin
  if lower(trim(coalesce(p_marketplace, ''))) not in ('amazon', 'walmart') then raise exception 'Marketplace must be Amazon or Walmart.' using errcode = 'P0001'; end if;
  if nullif(trim(coalesce(p_external_order_id, '')), '') is null then raise exception 'Marketplace order ID is required.' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item to the marketplace order.' using errcode = 'P0001'; end if;
  if p_financials is null or jsonb_typeof(p_financials) <> 'object' then raise exception 'Marketplace financial details are required.' using errcode = 'P0001'; end if;
  v_merchandise := greatest(0, coalesce((p_financials->>'merchandise_subtotal_cents')::int, 0));
  insert into public.marketplace_orders (
    marketplace, external_order_id, sold_at, notes, created_by, updated_by, currency,
    merchandise_subtotal_cents, shipping_charged_cents, discount_cents, tax_collected_cents,
    marketplace_fee_cents, payment_processing_fee_cents, shipping_cost_cents, other_cost_cents,
    refund_cents, net_payout_cents, financial_status
  ) values (
    lower(trim(p_marketplace)), trim(p_external_order_id), coalesce(p_sold_at, now()), nullif(trim(coalesce(p_notes, '')), ''), nullif(trim(coalesce(p_actor, '')), ''), nullif(trim(coalesce(p_actor, '')), ''),
    upper(coalesce(nullif(trim(p_financials->>'currency'), ''), 'USD')), v_merchandise,
    greatest(0, coalesce((p_financials->>'shipping_charged_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'discount_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'tax_collected_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'marketplace_fee_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'payment_processing_fee_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'shipping_cost_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'other_cost_cents')::int, 0)),
    greatest(0, coalesce((p_financials->>'refund_cents')::int, 0)),
    case when p_financials ? 'net_payout_cents' and p_financials->>'net_payout_cents' is not null then greatest(0, (p_financials->>'net_payout_cents')::int) else null end,
    case when p_financials->>'financial_status' in ('complete', 'partial_refund', 'refunded') then p_financials->>'financial_status' else 'estimated' end
  ) returning * into o;
  for item in select value from jsonb_array_elements(p_lines) as t(value) loop
    v_slug := trim(coalesce(item->>'product_slug', '')); v_size := trim(coalesce(item->>'size', ''));
    v_cases := greatest(0, coalesce((item->>'quantity_cases')::int, 0)); v_boxes := greatest(0, coalesce((item->>'quantity_boxes')::int, 0));
    if v_slug = '' or v_size = '' or (v_cases = 0 and v_boxes = 0) then raise exception 'Each marketplace item needs a product, size, and quantity.' using errcode = 'P0001'; end if;
    select pv.id into v_id from public.product_variants pv join public.products p on p.id = pv.product_id where p.slug = v_slug and lower(pv.size_label) in (lower(v_size), case lower(v_size) when 's' then 'small' when 'm' then 'medium' when 'l' then 'large' when 'xl' then 'x large' else lower(v_size) end) limit 1;
    if v_id is null then raise exception 'Inventory is not configured for % / %.', v_slug, v_size using errcode = 'P0001'; end if;
    insert into public.marketplace_order_lines (
      marketplace_order_id, variant_id, product_slug, size, quantity_cases, quantity_boxes,
      unit_type, unit_sale_price_cents, unit_cost_cents, line_revenue_cents, line_cost_cents
    ) values (
      o.id, v_id, v_slug, v_size, v_cases, v_boxes,
      case when item->>'unit_type' in ('case', 'box') then item->>'unit_type' when v_cases > 0 then 'case' else 'box' end,
      greatest(0, coalesce((item->>'unit_sale_price_cents')::int, 0)),
      greatest(0, coalesce((item->>'unit_cost_cents')::int, 0)),
      greatest(0, coalesce((item->>'line_revenue_cents')::int, 0)),
      greatest(0, coalesce((item->>'line_cost_cents')::int, 0))
    );
    v_ops := v_ops || jsonb_build_array(jsonb_build_object('variant_id', v_id, 'quantity_cases', v_cases, 'quantity_boxes', v_boxes, 'movement_type', 'marketplace_sale', 'reference_type', 'marketplace_order', 'reference_id', o.id::text, 'note', o.marketplace || ' ' || o.external_order_id, 'created_by', nullif(trim(coalesce(p_actor, '')), '')));
  end loop;
  perform public.inventory_consume_demands(v_ops);
  update public.marketplace_orders set inventory_committed_at = now(), updated_at = now() where id = o.id returning * into o;
  return to_jsonb(o);
exception when unique_violation then raise exception 'That marketplace order is already recorded.' using errcode = 'P0001';
end; $$;

create or replace function public.marketplace_order_transition(p_marketplace_order_id uuid, p_status text, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.marketplace_orders%rowtype; desired text := lower(trim(coalesce(p_status, ''))); ops jsonb := '[]'::jsonb; line public.marketplace_order_lines%rowtype; movement public.inventory_movements%rowtype; movement_count int := 0;
begin
  if desired not in ('new', 'packed', 'shipped', 'cancelled') then raise exception 'Marketplace order status is invalid.' using errcode = 'P0001'; end if;
  select * into o from public.marketplace_orders where id = p_marketplace_order_id for update;
  if not found then raise exception 'Marketplace order not found.' using errcode = 'P0001'; end if;
  if o.status = 'shipped' then
    if desired = 'shipped' then return to_jsonb(o); end if;
    raise exception 'A shipped marketplace order cannot be changed.' using errcode = 'P0001';
  end if;
  if o.status = 'cancelled' then raise exception 'A cancelled marketplace order cannot be changed.' using errcode = 'P0001'; end if;
  if desired = 'cancelled' then
    for movement in select * from public.inventory_movements where reference_type = 'marketplace_order' and reference_id = o.id::text and movement_type = 'marketplace_sale' order by created_at, id loop
      movement_count := movement_count + 1;
      ops := ops || jsonb_build_array(jsonb_build_object('variant_id', movement.variant_id, 'cases_delta', -movement.cases_delta, 'boxes_delta', -movement.boxes_delta, 'movement_type', 'marketplace_cancelled', 'reference_type', 'marketplace_order', 'reference_id', o.id::text, 'note', o.marketplace || ' ' || o.external_order_id || ' cancelled', 'created_by', nullif(trim(coalesce(p_actor, '')), '')));
    end loop;
    -- Compatibility for orders recorded before exact marketplace movements existed.
    if movement_count = 0 then
      for line in select * from public.marketplace_order_lines where marketplace_order_id = o.id loop
        ops := ops || jsonb_build_array(jsonb_build_object('variant_id', line.variant_id, 'cases_delta', line.quantity_cases, 'boxes_delta', line.quantity_boxes, 'movement_type', 'marketplace_cancelled', 'reference_type', 'marketplace_order', 'reference_id', o.id::text, 'note', o.marketplace || ' ' || o.external_order_id || ' cancelled', 'created_by', nullif(trim(coalesce(p_actor, '')), '')));
      end loop;
    end if;
    perform public.inventory_apply_ops(ops);
  end if;
  update public.marketplace_orders set status = desired, packed_at = case when desired = 'packed' then now() else packed_at end, shipped_at = case when desired = 'shipped' then now() else shipped_at end, updated_by = nullif(trim(coalesce(p_actor, '')), ''), updated_at = now() where id = o.id returning * into o;
  return to_jsonb(o);
end; $$;

grant select, insert, update, delete on public.marketplace_orders, public.marketplace_order_lines to service_role;
grant execute on function public.inventory_consume_demands(jsonb) to service_role;
grant execute on function public.marketplace_order_record(text, text, jsonb, jsonb, timestamptz, text, text) to service_role;
grant execute on function public.marketplace_order_transition(uuid, text, text) to service_role;

-- Make the new tables and RPC signatures visible to the Supabase REST API immediately.
notify pgrst, 'reload schema';
