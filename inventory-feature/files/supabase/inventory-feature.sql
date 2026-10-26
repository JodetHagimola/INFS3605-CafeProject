-- Run once in the Supabase SQL Editor for the team's demo project.
-- Existing inventory quantities and orders are not modified by this setup.
begin;

alter table public.inventory add column if not exists minimum_stock numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory'::regclass and conname = 'inventory_minimum_stock_nonnegative') then
    alter table public.inventory add constraint inventory_minimum_stock_nonnegative
      check (minimum_stock is null or (minimum_stock >= 0 and minimum_stock::text not in ('NaN', 'Infinity', '-Infinity')));
  end if;
end $$;

create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  ingredient_id bigint not null references public.inventory(ingredient_id),
  kind text not null check (kind in ('delivery', 'usage', 'waste')),
  amount numeric not null check (amount > 0),
  quantity_before numeric not null,
  quantity_after numeric not null check (quantity_after >= 0),
  note text not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.inventory_movements enable row level security;
revoke all on table public.inventory_movements from anon, authenticated;
grant select, insert on table public.inventory_movements to service_role;
grant usage, select on sequence public.inventory_movements_id_seq to service_role;

create or replace function public.record_inventory_movement(
  p_ingredient_id bigint,
  p_kind text,
  p_amount numeric,
  p_expected_updated timestamptz,
  p_note text
) returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_quantity numeric;
  v_updated timestamptz;
  v_next numeric;
begin
  if p_kind is null or p_kind not in ('delivery', 'usage', 'waste')
    or p_amount is null or p_amount <= 0 or p_amount > 1000000000
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <> trunc(p_amount, 6)
    or p_note is null or length(trim(p_note)) not between 1 and 200 then
    raise exception 'INVALID_MOVEMENT';
  end if;

  -- Lock the row before reading and updating. Check the timestamp to reject
  -- stale forms / repeated submissions rather than silently applying twice.
  select quantity_in_stock, last_updated into v_quantity, v_updated
    from public.inventory where ingredient_id = p_ingredient_id for update;
  if not found then raise exception 'NO_STOCK_RECORD'; end if;
  if p_expected_updated is null or v_updated is distinct from p_expected_updated then
    raise exception 'STALE_STOCK';
  end if;
  if v_quantity is null or v_quantity < 0 or v_quantity::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'INVALID_STOCK';
  end if;
  v_next := case when p_kind = 'delivery' then v_quantity + p_amount else v_quantity - p_amount end;
  if v_next < 0 then raise exception 'INSUFFICIENT_STOCK'; end if;

  update public.inventory set quantity_in_stock = v_next,
    last_updated = greatest(clock_timestamp(), v_updated + interval '1 millisecond')
    where ingredient_id = p_ingredient_id;
  insert into public.inventory_movements(ingredient_id, kind, amount, quantity_before, quantity_after, note)
    values (p_ingredient_id, p_kind, p_amount, v_quantity, v_next, trim(p_note));
  return v_next;
end;
$$;

revoke all on function public.record_inventory_movement(bigint,text,numeric,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_inventory_movement(bigint,text,numeric,timestamptz,text) to service_role;
commit;
