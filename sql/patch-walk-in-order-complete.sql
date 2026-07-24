-- Walk-in durable completion: inventory commit marker + exactly-once movements + atomic RPC.
-- Forward-only. Do not apply from this PR — deploy order: apply migration → deploy backend → verify → later frontend.
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- READ-ONLY PREFLIGHT (run manually; do not auto-mutate history)
-- ---------------------------------------------------------------------------
--
-- 1) Duplicate historical walk_in_sale movements (must investigate BEFORE unique index):
--
--   select reference_id, variant_id, count(*) as movement_count
--   from public.inventory_movements
--   where movement_type = 'walk_in_sale'
--     and coalesce(reference_type, '') = 'order'
--     and reference_id is not null
--   group by reference_id, variant_id
--   having count(*) > 1
--   order by movement_count desc, reference_id, variant_id;
--
-- Do not delete or rewrite duplicates automatically. Investigate each reference_id /
-- variant_id group against the related order before creating the unique index.
--
-- ---------------------------------------------------------------------------
-- A. Before applying the migration (column inventory_committed_at may not exist yet)
-- ---------------------------------------------------------------------------
-- List every existing paid Walk-in order WITHOUT referencing inventory_committed_at.
-- Every returned historical row requires reconciliation: after the migration adds the
-- marker column, it will initially be null for these rows (no automatic backfill).
--
--   select id, order_ref, payment_method, paid_at, order_status, admin_handoff_at,
--          status, created_at, updated_at
--   from public.orders
--   where order_source = 'walk_in'
--     and lower(coalesce(status, '')) = 'paid'
--   order by paid_at nulls last, updated_at desc;
--
-- ---------------------------------------------------------------------------
-- B. After applying the migration, before deploying the backend
-- ---------------------------------------------------------------------------
-- Confirm which paid Walk-in rows still need reconciliation once the column exists:
--
--   select id, order_ref, payment_method, paid_at, order_status, admin_handoff_at,
--          status, inventory_committed_at, created_at, updated_at
--   from public.orders
--   where order_source = 'walk_in'
--     and lower(coalesce(status, '')) = 'paid'
--     and inventory_committed_at is null
--   order by paid_at nulls last, updated_at desc;
--
-- Applying the migration does not backfill the marker.
-- Do not mark a historical order committed until its inventory movements have been
-- investigated. Do not decrement inventory automatically.
-- The new backend may be deployed only after the migration exists; historical
-- reconciliation can be tracked separately because old paid rows are not editable drafts.

-- ---------------------------------------------------------------------------
-- 1) Order-level inventory commit claim (exactly-once completion marker)
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists inventory_committed_at timestamptz;

comment on column public.orders.inventory_committed_at is
  'When Walk-in on-hand inventory was durably committed for this order (exactly once). Null until completion succeeds.';

-- ---------------------------------------------------------------------------
-- 2) Unique movement claim: one walk_in_sale row per order + variant
-- ---------------------------------------------------------------------------
create unique index if not exists inventory_movements_walk_in_sale_order_variant_uidx
  on public.inventory_movements (reference_id, variant_id)
  where movement_type = 'walk_in_sale'
    and coalesce(reference_type, '') = 'order'
    and reference_id is not null;

-- ---------------------------------------------------------------------------
-- 3) Atomic Walk-in completion: payment + handoff + inventory in one transaction
-- p_order_id is bigint to match Production public.orders.id (int8). Do not convert
-- the orders table to UUID. variant_id values remain UUID (inventory schema).
-- No UUID overload: the uuid signature was never applied to Production.
-- ---------------------------------------------------------------------------
create or replace function public.walk_in_order_complete(
  p_order_id bigint,
  p_payment_method text,
  p_inventory_ops jsonb,
  p_actor text default null
)
returns jsonb
language plpgsql
as $$
declare
  o public.orders%rowtype;
  v_payment_method text;
  v_completed_at timestamptz := now();
  v_payment_id text;
  v_actor text;
  v_ops jsonb;
  v_op jsonb;
  v_vid text;
  v_mt text;
  v_rt text;
  v_rid text;
  v_cases int;
  v_boxes int;
  v_seen jsonb := '{}'::jsonb;
  v_order_id_text text;
begin
  if p_order_id is null then
    raise exception 'orderId is required.' using errcode = 'P0001';
  end if;

  v_order_id_text := p_order_id::text;

  v_payment_method := lower(trim(coalesce(p_payment_method, '')));
  if v_payment_method is distinct from 'cash' and v_payment_method is distinct from 'check' then
    raise exception 'paymentMethod must be cash or check.' using errcode = 'P0001';
  end if;

  v_actor := nullif(trim(coalesce(p_actor, '')), '');
  v_ops := coalesce(p_inventory_ops, '[]'::jsonb);
  if jsonb_typeof(v_ops) <> 'array' then
    raise exception 'inventory ops must be a JSON array.' using errcode = 'P0001';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;

  -- Idempotent replay: strict completed Walk-in invariant
  -- (paid + shipped + admin_handoff_at + inventory_committed_at).
  if o.inventory_committed_at is not null
     and lower(coalesce(o.status, '')) = 'paid'
     and trim(coalesce(o.order_status, '')) = 'shipped'
     and o.admin_handoff_at is not null then
    if trim(coalesce(o.order_source, '')) is distinct from 'walk_in' then
      raise exception 'Only walk-in orders can be marked paid here.' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'order', to_jsonb(o)
    );
  end if;

  if trim(coalesce(o.order_source, '')) is distinct from 'walk_in' then
    raise exception 'Only walk-in orders can be marked paid here.' using errcode = 'P0001';
  end if;

  if trim(coalesce(o.order_status, '')) = 'cancelled' then
    raise exception 'Cancelled orders cannot be completed.' using errcode = 'P0001';
  end if;

  if trim(coalesce(o.order_status, '')) is distinct from 'draft' then
    raise exception 'Only walk-in drafts awaiting payment can be marked paid.' using errcode = 'P0001';
  end if;

  -- Validate every inventory op BEFORE mutating the order (unique index is second defense).
  if jsonb_array_length(v_ops) > 0 then
    for v_op in select value from jsonb_array_elements(v_ops) as t(value)
    loop
      if jsonb_typeof(v_op) is distinct from 'object' then
        raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end if;

      v_vid := nullif(trim(coalesce(v_op ->> 'variant_id', '')), '');
      if v_vid is null then
        raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end if;
      begin
        perform v_vid::uuid;
      exception
        when invalid_text_representation then
          raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end;

      v_mt := trim(coalesce(v_op ->> 'movement_type', ''));
      if v_mt is distinct from 'walk_in_sale' then
        raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end if;

      v_rt := trim(coalesce(v_op ->> 'reference_type', ''));
      if v_rt is distinct from 'order' then
        raise exception 'Walk-in inventory operation does not belong to this order.' using errcode = 'P0001';
      end if;

      v_rid := trim(coalesce(v_op ->> 'reference_id', ''));
      if v_rid is distinct from v_order_id_text then
        raise exception 'Walk-in inventory operation does not belong to this order.' using errcode = 'P0001';
      end if;

      begin
        v_cases := coalesce((v_op ->> 'cases_delta')::int, 0);
        v_boxes := coalesce((v_op ->> 'boxes_delta')::int, 0);
      exception
        when invalid_text_representation then
          raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
        when numeric_value_out_of_range then
          raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end;

      if v_cases = 0 and v_boxes = 0 then
        raise exception 'Invalid walk-in inventory operation.' using errcode = 'P0001';
      end if;

      if (v_seen ? v_vid) then
        raise exception 'Duplicate variant in walk-in inventory operations.' using errcode = 'P0001';
      end if;
      v_seen := v_seen || jsonb_build_object(v_vid, true);
    end loop;
  end if;

  v_payment_id := 'walk_in:' || v_payment_method;

  update public.orders as ord
  set
    status = 'paid',
    order_status = 'shipped',
    payment_method = v_payment_method,
    payment_id = v_payment_id,
    paid_at = v_completed_at,
    provider = 'walk_in',
    shipping_cents = 0,
    paid_shipping_amount_cents = 0,
    admin_handoff_at = v_completed_at,
    inventory_committed_at = v_completed_at,
    fulfillment_method = 'pickup',
    shipping_required = false,
    shippo_label_required = false,
    updated_at = v_completed_at
  where ord.id = p_order_id
    and ord.order_status = 'draft'
    and ord.inventory_committed_at is null
  returning * into o;

  if not found then
    raise exception 'Order could not be updated (it may have already been paid).' using errcode = 'P0001';
  end if;

  -- Stamp actor onto movement ops when provided (does not invent browser secrets).
  if v_actor is not null and jsonb_array_length(v_ops) > 0 then
    select coalesce(jsonb_agg(
      case
        when (op ->> 'created_by') is null or trim(coalesce(op ->> 'created_by', '')) = ''
          then op || jsonb_build_object('created_by', v_actor)
        else op
      end
    ), '[]'::jsonb)
    into v_ops
    from jsonb_array_elements(v_ops) as op;
  end if;

  if jsonb_array_length(v_ops) > 0 then
    perform public.inventory_apply_ops(v_ops);
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'order', to_jsonb(o)
  );
exception
  when unique_violation then
    raise exception 'Walk-in inventory was already committed for this order.' using errcode = 'P0001';
end;
$$;

comment on function public.walk_in_order_complete(bigint, text, jsonb, text) is
  'Atomically complete a Walk-in draft: record cash/check payment, mark handoff complete, commit walk_in_sale inventory exactly once. p_order_id matches Production orders.id bigint.';

revoke execute on function public.walk_in_order_complete(bigint, text, jsonb, text)
  from public, anon, authenticated;

grant execute on function public.walk_in_order_complete(bigint, text, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
