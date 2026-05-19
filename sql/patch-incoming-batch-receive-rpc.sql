-- Phase C: atomic incoming batch receive — run in Supabase SQL Editor after incoming_inventory_batches tables exist.
-- Locks the batch row, applies stock via inventory_apply_ops, persists line received_* and batch status in one transaction.
-- Receiving is only allowed when batch.status = arrived (not in_transit / planned / cancelled / received).

create or replace function public.resolve_variant_id_for_catalog_size(p_slug text, p_catalog_size text)
returns uuid
language sql
stable
as $$
  select pv.id
  from public.products p
  inner join public.product_variants pv on pv.product_id = p.id
  where p.slug = trim(p_slug)
    and (
      pv.size_label = trim(p_catalog_size)
      or (
        trim(p_catalog_size) in ('S', 'Small', 'SMALL', 's')
        and pv.size_label in ('S', 'Small')
      )
      or (
        trim(p_catalog_size) in ('M', 'Medium', 'MEDIUM', 'm')
        and pv.size_label in ('M', 'Medium')
      )
      or (
        trim(p_catalog_size) in ('L', 'Large', 'LARGE', 'l')
        and pv.size_label in ('L', 'Large')
      )
      or (
        trim(p_catalog_size) in ('XL', 'X Large', 'X LARGE', 'xl')
        and pv.size_label in ('XL', 'X Large')
      )
    )
  limit 1;
$$;

comment on function public.resolve_variant_id_for_catalog_size(text, text) is
  'Maps storefront/catalog size labels to product_variants.id (same idea as lib/size-labels.js).';

create or replace function public.incoming_batch_receive(
  p_batch_id uuid,
  p_line_receipts jsonb,
  p_actor text,
  p_note text default null
)
returns void
language plpgsql
as $$
declare
  b record;
  line_count int;
  receipt_count int;
  total_recv int := 0;
  rec jsonb;
  line_id uuid;
  rc int;
  rb int;
  line_row record;
  batch_line record;
  vid uuid;
  ops jsonb := '[]'::jsonb;
  mv_note text;
  actor_trim text;
begin
  if p_batch_id is null then
    raise exception 'batch id is required';
  end if;

  actor_trim := nullif(trim(coalesce(p_actor, '')), '');
  mv_note := coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Incoming batch receive');

  select * into b from public.incoming_inventory_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Batch not found.';
  end if;

  if b.status = 'received' then
    raise exception 'Batch has already been received.';
  end if;

  if b.status = 'cancelled' then
    raise exception 'Cannot receive a cancelled batch.';
  end if;

  -- Explicit policy: only arrived batches may be received (inventory physically on site).
  if b.status <> 'arrived' then
    raise exception 'Batch must be in arrived status before receiving (current status: %).', b.status;
  end if;

  select count(*)::int into line_count from public.incoming_inventory_batch_lines where batch_id = p_batch_id;

  if line_count < 1 then
    raise exception 'Batch has no lines to receive.';
  end if;

  if p_line_receipts is null or jsonb_typeof(p_line_receipts) <> 'array' then
    raise exception 'line receipts must be a JSON array.';
  end if;

  receipt_count := jsonb_array_length(p_line_receipts);
  if receipt_count <> line_count then
    raise exception 'Receipt payload must include exactly % line(s); got %.', line_count, receipt_count;
  end if;

  if exists (
    select 1
    from (
      select rec_inner ->> 'line_id' as lid
      from jsonb_array_elements(p_line_receipts) as rec_inner
      group by 1
      having count(*) > 1
    ) d
  ) then
    raise exception 'Duplicate line_id in receipt payload.';
  end if;

  -- Every batch line must appear exactly once in the payload.
  for batch_line in select id from public.incoming_inventory_batch_lines where batch_id = p_batch_id
  loop
    if not exists (
      select 1 from jsonb_array_elements(p_line_receipts) e where (e ->> 'line_id')::uuid = batch_line.id
    ) then
      raise exception 'Missing line_id % in receipt payload.', batch_line.id;
    end if;
  end loop;

  -- Validate receipts, resolve variants, build inventory_apply_ops payload.
  for rec in select * from jsonb_array_elements(p_line_receipts)
  loop
    begin
      line_id := (rec ->> 'line_id')::uuid;
    exception when others then
      raise exception 'Invalid line_id in receipt payload.';
    end;

    rc := greatest(coalesce((rec ->> 'received_cases')::int, 0), 0);
    rb := greatest(coalesce((rec ->> 'received_boxes')::int, 0), 0);

    select * into line_row from public.incoming_inventory_batch_lines
      where id = line_id and batch_id = p_batch_id for update;

    if not found then
      raise exception 'Unknown line_id % for this batch.', line_id;
    end if;

    total_recv := total_recv + rc + rb;

    vid := public.resolve_variant_id_for_catalog_size(line_row.product_slug, line_row.size);
    if vid is null then
      raise exception 'No inventory variant found for product_slug=% size=%.', line_row.product_slug, line_row.size;
    end if;

    if rc <> 0 or rb <> 0 then
      ops := ops || jsonb_build_array(
        jsonb_build_object(
          'variant_id', vid::text,
          'cases_delta', rc,
          'boxes_delta', rb,
          'movement_type', 'receive_shipment',
          'note', mv_note,
          'reference_type', 'incoming_batch',
          'reference_id', p_batch_id::text,
          'created_by', coalesce(actor_trim, '')
        )
      );
    end if;
  end loop;

  if total_recv < 1 then
    raise exception 'At least one received_cases or received_boxes must be greater than 0 across all lines.';
  end if;

  perform public.inventory_apply_ops(ops);

  for rec in select * from jsonb_array_elements(p_line_receipts)
  loop
    line_id := (rec ->> 'line_id')::uuid;
    rc := greatest(coalesce((rec ->> 'received_cases')::int, 0), 0);
    rb := greatest(coalesce((rec ->> 'received_boxes')::int, 0), 0);

    update public.incoming_inventory_batch_lines
      set received_cases = rc,
          received_boxes = rb,
          updated_at = now()
    where id = line_id and batch_id = p_batch_id;
  end loop;

  update public.incoming_inventory_batches
    set status = 'received',
        received_at = now(),
        received_by = actor_trim,
        updated_by = actor_trim,
        updated_at = now()
    where id = p_batch_id;
end;
$$;

comment on function public.incoming_batch_receive(uuid, jsonb, text, text) is
  'Atomically receive an arrived incoming batch: inventory_apply_ops + line totals + batch terminal status. Idempotent at DB level via batch row lock and status check.';

grant execute on function public.resolve_variant_id_for_catalog_size(text, text) to service_role;
grant execute on function public.incoming_batch_receive(uuid, jsonb, text, text) to service_role;
