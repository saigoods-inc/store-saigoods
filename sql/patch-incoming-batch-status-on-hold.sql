-- Add `on_hold` to incoming_inventory_batches.status (Supabase SQL Editor, rerunnable).
-- Hold = shipment has issues; receive RPC still requires status = 'arrived' only (unchanged).

alter table public.incoming_inventory_batches
  drop constraint if exists incoming_inventory_batches_status_check;

alter table public.incoming_inventory_batches
  add constraint incoming_inventory_batches_status_check
  check (
    status in (
      'planned',
      'in_transit',
      'arrived',
      'on_hold',
      'received',
      'cancelled'
    )
  );

comment on constraint incoming_inventory_batches_status_check on public.incoming_inventory_batches is
  'Batch lifecycle: planned → in_transit → arrived (receivable) or on_hold (blocked from receive until returned to arrived).';
