-- Prerequisite: the existing inventory-feature.sql has been installed.
-- Adds sale records and a transactional RPC. Does not seed or reset stock.
begin;

create table if not exists public.inventory_sales (
  id uuid primary key,
  product_name text not null check (length(btrim(product_name)) between 1 and 120),
  quantity integer not null check (quantity between 1 and 1000),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.inventory_sale_ingredients (
  sale_id uuid not null references public.inventory_sales(id),
  ingredient_id bigint not null references public.inventory(ingredient_id),
  ingredient_name text not null,
  unit text not null,
  quantity_per_drink numeric not null check (quantity_per_drink > 0),
  amount numeric not null check (amount > 0),
  quantity_before numeric not null check (quantity_before >= 0),
  quantity_after numeric not null check (quantity_after >= 0),
  movement_id bigint not null unique references public.inventory_movements(id),
  primary key (sale_id, ingredient_id)
);

alter table public.inventory_sales enable row level security;
alter table public.inventory_sale_ingredients enable row level security;
revoke all on public.inventory_sales, public.inventory_sale_ingredients from public, anon, authenticated;
grant select, insert on public.inventory_sales, public.inventory_sale_ingredients to service_role;

create or replace function public.record_inventory_sale(
  p_request_id uuid, p_product_name text, p_quantity integer
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_existing public.inventory_sales%rowtype;
  v_rows jsonb;
  v_row record;
  v_stock numeric;
  v_updated timestamptz;
  v_amount numeric;
  v_movement bigint;
  v_replayed boolean := false;
begin
  if p_request_id is null or p_product_name is null
     or length(btrim(p_product_name)) not between 1 and 120
     or p_quantity is null or p_quantity not between 1 and 1000 then
    raise exception 'INVALID_SALE';
  end if;

  -- A retry uses the same UUID. Concurrent retries serialize before checking it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  select * into v_existing from public.inventory_sales where id = p_request_id;
  if found then
    if v_existing.product_name <> p_product_name or v_existing.quantity <> p_quantity then
      raise exception 'SALE_REQUEST_CONFLICT';
    end if;
    v_replayed := true;
  else
    -- Capture the complete recipe in one query. Later recipe edits cannot
    -- change the ingredient quantities within this sale or its saved receipt.
    select jsonb_agg(jsonb_build_object(
      'ingredient_id', r.ingredient_id, 'ingredient_name', i.ingredient_name,
      'unit', i.unit, 'per_drink', r.quantity_required
    ) order by r.ingredient_id) into v_rows
    from public.recipes r left join public.ingredients i using (ingredient_id)
    where r.product_name = p_product_name;
    if v_rows is null then raise exception 'RECIPE_NOT_FOUND'; end if;
    if exists (
      select 1 from jsonb_to_recordset(v_rows)
      as x(ingredient_id bigint, ingredient_name text, unit text, per_drink numeric)
      where ingredient_id is null or ingredient_name is null or btrim(ingredient_name) = ''
        or unit is null or btrim(unit) = '' or per_drink is null or per_drink <= 0
        or per_drink::text in ('NaN','Infinity','-Infinity')
        or per_drink <> trunc(per_drink, 6) or per_drink * p_quantity > 1000000000
    ) or exists (
      select ingredient_id from jsonb_to_recordset(v_rows) as x(ingredient_id bigint)
      group by ingredient_id having count(*) > 1
    ) then raise exception 'INVALID_RECIPE'; end if;

    -- Lock ingredients in the same order for every sale to avoid deadlocks.
    for v_row in select * from jsonb_to_recordset(v_rows)
      as x(ingredient_id bigint, ingredient_name text, unit text, per_drink numeric)
      order by ingredient_id
    loop
      select quantity_in_stock into v_stock from public.inventory
      where ingredient_id = v_row.ingredient_id for update;
      if not found then raise exception 'NO_STOCK_RECORD'; end if;
      if v_stock is null or v_stock < 0 or v_stock::text in ('NaN','Infinity','-Infinity') then
        raise exception 'INVALID_STOCK';
      end if;
      if v_stock < v_row.per_drink * p_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
    end loop;

    insert into public.inventory_sales(id, product_name, quantity)
    values (p_request_id, p_product_name, p_quantity);
    for v_row in select * from jsonb_to_recordset(v_rows)
      as x(ingredient_id bigint, ingredient_name text, unit text, per_drink numeric)
      order by ingredient_id
    loop
      select quantity_in_stock, last_updated into v_stock, v_updated
      from public.inventory where ingredient_id = v_row.ingredient_id;
      v_amount := v_row.per_drink * p_quantity;
      update public.inventory set quantity_in_stock = v_stock - v_amount,
        last_updated = greatest(clock_timestamp(), v_updated + interval '1 millisecond')
      where ingredient_id = v_row.ingredient_id;
      insert into public.inventory_movements
        (ingredient_id, kind, amount, quantity_before, quantity_after, note)
      values (v_row.ingredient_id, 'usage', v_amount, v_stock, v_stock - v_amount,
        'Sale ' || p_request_id::text || ': ' || p_quantity::text || ' x ' || p_product_name)
      returning id into v_movement;
      insert into public.inventory_sale_ingredients
        (sale_id, ingredient_id, ingredient_name, unit, quantity_per_drink,
         amount, quantity_before, quantity_after, movement_id)
      values (p_request_id, v_row.ingredient_id, v_row.ingredient_name, v_row.unit,
        v_row.per_drink, v_amount, v_stock, v_stock - v_amount, v_movement);
    end loop;
  end if;

  return jsonb_build_object('sale_id', p_request_id, 'product_name', p_product_name,
    'quantity', p_quantity, 'replayed', v_replayed,
    'changes', (select jsonb_agg(jsonb_build_object(
      'ingredient_id', ingredient_id::text, 'name', ingredient_name, 'unit', unit,
      'amount', amount::text, 'before', quantity_before::text, 'after', quantity_after::text
    ) order by ingredient_id) from public.inventory_sale_ingredients where sale_id = p_request_id));
end;
$$;

revoke all on function public.record_inventory_sale(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.record_inventory_sale(uuid,text,integer) to service_role;
commit;
