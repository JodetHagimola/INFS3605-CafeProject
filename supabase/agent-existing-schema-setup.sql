-- Compatibility setup for the existing Brewlytics database schema.
-- Run before agent-write-tools.sql and agent-first-app.sql.
-- This does not seed sales, supplier prices, deliveries, or inventory.
begin;

do $$
begin
  if to_regclass('public."Historical Sales Data"') is null then
    raise exception 'Expected public."Historical Sales Data" was not found.';
  end if;
  if to_regclass('public.sales_history') is not null then
    raise exception 'public.sales_history already exists; inspect it before creating the compatibility view.';
  end if;
  if to_regclass('public.delivery_receipts') is null then
    raise exception 'Expected public.delivery_receipts was not found.';
  end if;
  if to_regprocedure('public.record_inventory_movement(bigint,text,numeric,timestamp with time zone,text)') is null then
    raise exception 'Expected record_inventory_movement(...) was not found.';
  end if;
end
$$;

create table if not exists public.agent_activity (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default clock_timestamp(),
  tool text not null check (length(trim(tool)) between 1 and 80),
  input_summary text not null check (length(input_summary) <= 1000),
  outcome text not null check (outcome in ('started', 'success', 'blocked', 'error')),
  reason text not null check (length(reason) <= 1000)
);

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

create index if not exists agent_activity_created_at_idx
  on public.agent_activity (created_at desc);
create index if not exists approval_inbox_status_created_at_idx
  on public.approval_inbox (status, created_at desc);

alter table public.agent_activity enable row level security;
alter table public.approval_inbox enable row level security;
revoke all on table public.agent_activity from public, anon, authenticated;
revoke all on table public.approval_inbox from public, anon, authenticated;
grant select, insert, update on table public.agent_activity to service_role;
grant usage, select on sequence public.agent_activity_id_seq to service_role;
grant select, insert, update on table public.approval_inbox to service_role;

-- The existing receipt ledger stores received quantity and timestamp as
-- amount and created_at. These generated aliases keep the app's read contract.
alter table public.delivery_receipts
  add column if not exists agent_activity_id bigint
    references public.agent_activity(id);
alter table public.delivery_receipts
  add column if not exists received_quantity numeric
    generated always as (amount) stored;
alter table public.delivery_receipts
  add column if not exists received_at timestamptz
    generated always as (created_at) stored;

create unique index if not exists delivery_receipts_agent_activity_id_idx
  on public.delivery_receipts (agent_activity_id)
  where agent_activity_id is not null;

alter table public.delivery_receipts enable row level security;
revoke all on table public.delivery_receipts from public, anon, authenticated;
grant select, insert on table public.delivery_receipts to service_role;

create or replace function public.try_parse_agent_iso_date(p_value text)
returns date
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  if p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_value::date;
exception
  when others then return null;
end;
$$;

create view public.sales_history
with (security_invoker = true)
as
select
  grouped.sales_date,
  grouped.product_name,
  grouped.total_units::integer as units_sold,
  grouped.is_public_holiday,
  'imported'::text as source
from (
  select
    valid_rows.sales_date,
    valid_rows.product_name,
    sum(valid_rows.quantity_sold) as total_units,
    bool_or(coalesce(valid_rows.is_public_holiday, 0) <> 0) as is_public_holiday
  from (
    select
      public.try_parse_agent_iso_date("date") as sales_date,
      product_name,
      quantity_sold,
      is_public_holiday
    from public."Historical Sales Data"
  ) as valid_rows
  where valid_rows.sales_date is not null
    and valid_rows.product_name is not null
    and length(trim(valid_rows.product_name)) between 1 and 120
    and valid_rows.quantity_sold between 0 and 2147483647
  group by valid_rows.sales_date, valid_rows.product_name
) as grouped
where grouped.total_units between 0 and 2147483647;

revoke all on function public.try_parse_agent_iso_date(text) from public, anon, authenticated;
grant execute on function public.try_parse_agent_iso_date(text) to service_role;
revoke all on public.sales_history from public, anon, authenticated;
grant select on public."Historical Sales Data" to service_role;
grant select on public.sales_history to service_role;

commit;
