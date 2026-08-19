alter table public.discount_codes
  add column if not exists percent_off integer not null default 7;

alter table public.discount_codes
  drop constraint if exists discount_codes_percent_off_check;

alter table public.discount_codes
  add constraint discount_codes_percent_off_check
  check (percent_off between 1 and 100);

comment on column public.discount_codes.percent_off is
  'Percentage deducted from merchandise when this one-time code is redeemed.';
