-- Order tagging for Hardin County discount checkout (run in Supabase).

alter table public.orders add column if not exists discount_code_used text;
alter table public.orders add column if not exists is_hardin_discount boolean not null default false;

comment on column public.orders.discount_code_used is 'Hardin promo code applied at checkout (one-time), if any.';
comment on column public.orders.is_hardin_discount is 'True when Hardin County pricing + valid code was applied.';
