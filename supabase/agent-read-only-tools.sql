-- Run manually in the Supabase SQL Editor to enable sales and delivery reads.
-- This file is not applied automatically. Demo sales below are synthetic and
-- must not be used as evidence for real purchasing decisions.
begin;

create table if not exists public.sales_history (
  sales_date date not null,
  product_name text not null check (length(trim(product_name)) between 1 and 120),
  units_sold integer not null check (units_sold >= 0),
  is_public_holiday boolean not null default false,
  source text not null default 'synthetic_demo'
    check (source in ('synthetic_demo', 'imported')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (sales_date, product_name)
);

create index if not exists sales_history_product_date_idx
  on public.sales_history (product_name, sales_date desc);

create table if not exists public.delivery_receipts (
  id bigint generated always as identity primary key,
  delivery_id bigint not null references public.incoming_deliveries(delivery_id),
  received_quantity numeric not null check (received_quantity > 0),
  received_at timestamptz not null default clock_timestamp(),
  note text not null default '' check (length(note) <= 200)
);

create table if not exists public.agent_activity (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default clock_timestamp(),
  tool text not null check (length(trim(tool)) between 1 and 80),
  input_summary text not null check (length(input_summary) <= 1000),
  outcome text not null check (outcome in ('started', 'success', 'blocked', 'error')),
  reason text not null check (length(reason) <= 1000)
);

alter table public.delivery_receipts
  add column if not exists agent_activity_id bigint references public.agent_activity(id);

create table if not exists public.approval_inbox (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in (
    'place_or_send_order', 'contact_supplier', 'switch_supplier', 'change_supplier_price'
  )),
  summary text not null check (length(trim(summary)) between 1 and 500),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewer_note text check (reviewer_note is null or length(reviewer_note) <= 500),
  check (
    (status = 'pending_approval' and reviewed_at is null)
    or (status in ('approved', 'rejected') and reviewed_at is not null)
  )
);

create index if not exists delivery_receipts_delivery_id_idx
  on public.delivery_receipts (delivery_id, received_at desc);
create unique index if not exists delivery_receipts_agent_activity_id_idx
  on public.delivery_receipts (agent_activity_id)
  where agent_activity_id is not null;
create index if not exists agent_activity_created_at_idx
  on public.agent_activity (created_at desc);
create index if not exists approval_inbox_status_created_at_idx
  on public.approval_inbox (status, created_at desc);

alter table public.sales_history enable row level security;
revoke all on table public.sales_history from public, anon, authenticated;
grant select on table public.sales_history to service_role;

alter table public.delivery_receipts enable row level security;
revoke all on table public.delivery_receipts from public, anon, authenticated;
grant select on table public.delivery_receipts to service_role;

alter table public.agent_activity enable row level security;
revoke all on table public.agent_activity from public, anon, authenticated;
grant select, insert, update on table public.agent_activity to service_role;
grant usage, select on sequence public.agent_activity_id_seq to service_role;

alter table public.approval_inbox enable row level security;
revoke all on table public.approval_inbox from public, anon, authenticated;
grant select, insert, update on table public.approval_inbox to service_role;

-- Seed 56 days of explicitly synthetic demo sales for products already in recipes.
-- Re-running the script does not overwrite existing sales records.
insert into public.sales_history
  (sales_date, product_name, units_sold, is_public_holiday, source)
with calendar as (
  select day::date as sales_date
  from generate_series(current_date - 56, current_date - 1, interval '1 day') as date_series(day)
),
products as (
  select product_name, row_number() over (order by product_name)::integer as product_rank
  from (select distinct product_name from public.recipes) as recipe_products
)
select
  calendar.sales_date,
  products.product_name,
  greatest(
    0,
    25 + products.product_rank * 4
      + extract(isodow from calendar.sales_date)::integer * 2
      + (extract(day from calendar.sales_date)::integer % 7)
  ),
  false,
  'synthetic_demo'
from calendar
cross join products
on conflict (sales_date, product_name) do nothing;

commit;
