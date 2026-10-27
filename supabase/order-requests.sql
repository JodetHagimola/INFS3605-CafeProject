-- Run once in the Supabase SQL Editor to enable chef order requests.
begin;

create table if not exists public.order_requests (
  id uuid primary key default gen_random_uuid(),
  chef_name text not null check (length(trim(chef_name)) between 1 and 80),
  needed_by date not null,
  notes text not null default '' check (length(notes) <= 500),
  items jsonb not null check (
    jsonb_typeof(items) = 'array'
    and jsonb_array_length(items) between 1 and 20
  ),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approver_name text,
  decision_note text,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  check (
    (status = 'pending' and approver_name is null and decided_at is null)
    or (status in ('approved', 'rejected') and approver_name is not null and decided_at is not null)
  )
);

create index if not exists order_requests_created_at_idx
  on public.order_requests (created_at desc);
create index if not exists order_requests_status_created_at_idx
  on public.order_requests (status, created_at desc);

alter table public.order_requests enable row level security;
revoke all on table public.order_requests from anon, authenticated;
grant select, insert, update on table public.order_requests to service_role;

commit;
