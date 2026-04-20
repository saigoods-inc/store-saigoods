-- Optional: documents that admin_external_label_storage_path and admin_external_packing_slip_storage_path
-- may hold multiple Supabase Storage object paths, one per line (same pattern as multi-line tracking).
-- No schema change required — columns are already `text`. Safe to re-run.

comment on column public.orders.admin_external_label_storage_path is
  'Supabase Storage paths for uploaded shipping labels (one path per line if multiple files).';
comment on column public.orders.admin_external_packing_slip_storage_path is
  'Supabase Storage paths for uploaded packing slips (one path per line if multiple files).';

notify pgrst, 'reload schema';
