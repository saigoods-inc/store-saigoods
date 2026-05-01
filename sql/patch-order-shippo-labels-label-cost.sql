-- Optional alias for reporting: label purchase cost is stored in amount_cents today.
-- After apply: NOTIFY pgrst, 'reload schema';

alter table public.order_shippo_labels
  add column if not exists label_cost_cents integer;

update public.order_shippo_labels
set label_cost_cents = amount_cents
where label_cost_cents is null and amount_cents is not null;

comment on column public.order_shippo_labels.label_cost_cents is
  'Optional mirror of amount_cents for clarity in reporting; app may write both.';

notify pgrst, 'reload schema';
