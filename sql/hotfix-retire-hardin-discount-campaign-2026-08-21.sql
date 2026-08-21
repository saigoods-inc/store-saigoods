-- Guarded retirement of the unused Hardin County campaign code batch.
-- This aborts without deleting anything unless the production batch is exactly
-- the expected 60 unused HC-* codes.
begin;

do $$
declare
  matching_count integer;
  used_count integer;
begin
  select count(*) into matching_count
  from public.discount_codes
  where code like 'HC-%';

  select count(*) into used_count
  from public.discount_codes
  where code like 'HC-%'
    and is_used is true;

  if matching_count <> 60 then
    raise exception 'Expected exactly 60 HC-* codes, found %; no rows deleted.', matching_count;
  end if;

  if used_count <> 0 then
    raise exception 'Expected all HC-* codes to be unused, found % used; no rows deleted.', used_count;
  end if;

  delete from public.discount_codes
  where code like 'HC-%'
    and is_used is false;
end $$;

commit;
