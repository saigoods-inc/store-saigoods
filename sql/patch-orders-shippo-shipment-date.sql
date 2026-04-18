-- Optional: when set, POST /shipments/ includes shipment_date (see lib/shippo-shipment-sync.js).
alter table public.orders add column if not exists shippo_shipment_date text;

comment on column public.orders.shippo_shipment_date is 'Calendar date YYYY-MM-DD for carrier tender / pickup; sent to Shippo as shipment_date when creating the shipment.';

notify pgrst, 'reload schema';
