-- Admin guided fulfillment (checkpoints + optional Shippo address overrides).
alter table public.orders add column if not exists admin_fulfillment_print_done_at timestamptz;
alter table public.orders add column if not exists admin_fulfillment_summary_done_at timestamptz;
alter table public.orders add column if not exists admin_handoff_at timestamptz;
alter table public.orders add column if not exists admin_buyer_notify_sent_at timestamptz;
alter table public.orders add column if not exists shippo_from_address_override_json jsonb;
alter table public.orders add column if not exists shippo_return_address_override_json jsonb;

comment on column public.orders.admin_fulfillment_print_done_at is 'Staff confirmed print/download step after label purchase.';
comment on column public.orders.admin_fulfillment_summary_done_at is 'Staff completed summary review (unlocks status step).';
comment on column public.orders.admin_handoff_at is 'Staff confirmed package dropped off / handed to carrier.';
comment on column public.orders.admin_buyer_notify_sent_at is 'When shipping notification email was sent to buyer.';
comment on column public.orders.shippo_from_address_override_json is 'Optional sender override { name, line1, line2?, city, state, postalCode, country, email?, phone? } for Shippo.';
comment on column public.orders.shippo_return_address_override_json is 'Optional return address override (same shape as from).';

notify pgrst, 'reload schema';
