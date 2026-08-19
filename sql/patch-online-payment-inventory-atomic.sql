-- Run in Supabase before enabling live Square payments.
-- Atomically commits online-order inventory and the paid order transition.

alter table public.orders
  add column if not exists inventory_committed_at timestamptz,
  add column if not exists payment_reconciliation_required boolean not null default false,
  add column if not exists payment_reconciliation_error text;

create or replace function public.online_order_payment_complete(
  p_order_id text,
  p_payment_id text,
  p_paid_total_cents integer,
  p_inventory_ops jsonb,
  p_customer_address text default null,
  p_buyer_email text default null,
  p_buyer_phone text default null,
  p_buyer_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders%rowtype;
  v_subtotal integer;
  v_tax integer;
  v_shipping integer;
  v_now timestamptz := now();
begin
  if nullif(trim(coalesce(p_order_id, '')), '') is null
     or nullif(trim(coalesce(p_payment_id, '')), '') is null then
    raise exception 'Order and payment are required.' using errcode = 'P0001';
  end if;
  if p_paid_total_cents is null or p_paid_total_cents < 1 then
    raise exception 'Paid total is invalid.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_inventory_ops, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Inventory operations are invalid.' using errcode = 'P0001';
  end if;

  select * into o from public.orders where id::text = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  if trim(coalesce(o.order_source, '')) is distinct from 'web' then
    raise exception 'Only online orders can be finalized here.' using errcode = 'P0001';
  end if;

  if lower(coalesce(o.status, '')) = 'paid' and o.inventory_committed_at is not null then
    if trim(coalesce(o.payment_id, '')) is distinct from trim(p_payment_id) then
      raise exception 'Order payment does not match.' using errcode = 'P0001';
    end if;
    return jsonb_build_object('ok', true, 'idempotent', true, 'order', to_jsonb(o));
  end if;

  if trim(coalesce(o.order_status, '')) = 'cancelled' then
    raise exception 'Cancelled order cannot be finalized.' using errcode = 'P0001';
  end if;

  if jsonb_array_length(coalesce(p_inventory_ops, '[]'::jsonb)) > 0 then
    perform public.inventory_apply_ops(p_inventory_ops);
  end if;

  v_subtotal := greatest(0, coalesce(o.subtotal_cents, 0));
  v_tax := greatest(0, coalesce(o.tax_cents, 0));
  v_shipping := greatest(0, p_paid_total_cents - v_subtotal - v_tax);

  update public.orders
  set status = 'paid',
      order_status = 'paid_label_pending',
      payment_id = trim(p_payment_id),
      total_cents = p_paid_total_cents,
      shipping_cents = v_shipping,
      paid_shipping_amount_cents = v_shipping,
      customer_address = coalesce(nullif(trim(p_customer_address), ''), customer_address),
      customer_email = coalesce(nullif(trim(p_buyer_email), ''), customer_email),
      customer_phone = coalesce(nullif(trim(p_buyer_phone), ''), customer_phone),
      customer_name = coalesce(nullif(trim(p_buyer_name), ''), customer_name),
      inventory_committed_at = v_now,
      payment_reconciliation_required = false,
      payment_reconciliation_error = null,
      updated_at = v_now
  where id::text = p_order_id
  returning * into o;

  return jsonb_build_object('ok', true, 'idempotent', false, 'order', to_jsonb(o));
end;
$$;

revoke all on function public.online_order_payment_complete(text, text, integer, jsonb, text, text, text, text) from public;
grant execute on function public.online_order_payment_complete(text, text, integer, jsonb, text, text, text, text) to service_role;
