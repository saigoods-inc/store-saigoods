-- Track the latest successful cancellation/refund status email for each order.
-- Safe to re-run before deploying the matching application code.

alter table public.orders
  add column if not exists cancellation_email_sent_at timestamptz,
  add column if not exists cancellation_email_resend_id text;

comment on column public.orders.cancellation_email_sent_at is
  'When the most recent cancellation/refund status email was successfully accepted by Resend.';
comment on column public.orders.cancellation_email_resend_id is
  'Resend email id for the most recent successful cancellation/refund status email.';

notify pgrst, 'reload schema';
