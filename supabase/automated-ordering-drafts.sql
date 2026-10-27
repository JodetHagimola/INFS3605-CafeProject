-- Run once in the Supabase SQL Editor to enable automated-ordering drafts.
begin;

create table if not exists public.draft_orders (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  forecast_date date not null,
  forecast jsonb not null check (jsonb_typeof(forecast) = 'object'),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  flags jsonb not null check (jsonb_typeof(flags) = 'array'),
  data_used jsonb not null check (jsonb_typeof(data_used) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  approved_at timestamptz,
  check (
    (status = 'draft' and approved_at is null)
    or (status = 'approved' and approved_at is not null)
  )
);

create index if not exists draft_orders_created_at_idx
  on public.draft_orders (created_at desc);

alter table public.draft_orders enable row level security;
revoke all on table public.draft_orders from public, anon, authenticated;
grant select, insert, update on table public.draft_orders to service_role;

commit;
