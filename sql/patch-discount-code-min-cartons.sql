-- Apply to the isolated preview database first, then production only at approved release.
-- Existing codes keep their current behavior: 0 means no carton minimum.
begin;
alter table public.discount_codes
  add column if not exists min_cartons integer not null default 0;
alter table public.discount_codes
  drop constraint if exists discount_codes_min_cartons_check;
alter table public.discount_codes
  add constraint discount_codes_min_cartons_check check (min_cartons >= 0);
comment on column public.discount_codes.min_cartons is
  'Minimum actual cartons across all products and sizes; loose boxes do not count. Zero means no minimum.';
notify pgrst, 'reload schema';
commit;
