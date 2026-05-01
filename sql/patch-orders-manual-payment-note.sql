-- Optional staff note when recording in-person payment on pay-later manual orders.
-- Safe to re-run.

alter table public.orders add column if not exists manual_payment_note text;

comment on column public.orders.manual_payment_note is
  'Optional admin note for manual pay-later order when payment is recorded (cash/check/other).';

notify pgrst, 'reload schema';
