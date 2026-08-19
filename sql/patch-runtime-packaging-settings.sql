-- Durable admin-managed runtime settings. Server APIs use the service role;
-- browser clients receive no direct table access.

create table if not exists public.admin_runtime_settings (
  setting_key text primary key,
  setting_value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.admin_runtime_settings enable row level security;
revoke all on table public.admin_runtime_settings from anon, authenticated;

comment on table public.admin_runtime_settings is
  'Server-only configuration edited by authorized staff, including fulfillment packaging profiles.';
