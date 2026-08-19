-- Run in Supabase before launch, then insert each staff member's auth.users id.
-- Example (replace both values):
-- insert into public.admin_users (user_id, email)
-- values ('00000000-0000-0000-0000-000000000000', 'owner@example.com')
-- on conflict (user_id) do update set email = excluded.email, active = true;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = auth.uid() and active = true
  );
$$;

revoke all on function public.is_admin_user() from public;
grant execute on function public.is_admin_user() to authenticated;

drop policy if exists "Staff can read orders" on public.orders;
create policy "Staff can read orders" on public.orders
  for select to authenticated
  using (public.is_admin_user());

drop policy if exists "Staff can update orders" on public.orders;
create policy "Staff can update orders" on public.orders
  for update to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

grant select, update on public.orders to authenticated;
