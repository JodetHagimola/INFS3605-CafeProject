-- Install after inventory-agent-integration.sql. Existing receipts stay as recorded.
begin;

create table if not exists public.delivery_arrival_decisions (
  receipt_id uuid primary key references public.delivery_receipts(id),
  is_final boolean not null
);

create table if not exists public.delivery_shortage_drafts (
  receipt_id uuid primary key references public.delivery_receipts(id),
  delivery_id bigint not null unique references public.incoming_deliveries(delivery_id),
  facts jsonb not null,
  approach text check (approach in ('replacement_eta', 'dispatch_check')),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.delivery_arrival_decisions enable row level security;
alter table public.delivery_shortage_drafts enable row level security;
revoke all on public.delivery_arrival_decisions, public.delivery_shortage_drafts from public, anon, authenticated;
grant select, insert on public.delivery_arrival_decisions, public.delivery_shortage_drafts to service_role;
grant update (approach) on public.delivery_shortage_drafts to service_role;

create or replace view public.agent_delivery_status with (security_invoker=true) as
select d.*, f.receipt_id is not null as closed_short
from public.incoming_deliveries d left join public.delivery_shortage_drafts f using (delivery_id);

create or replace view public.open_incoming_deliveries with (security_invoker=true) as
select * from public.agent_delivery_status where not closed_short;

create or replace view public.open_delivery_balances with (security_invoker=true) as
select b.* from public.inventory_delivery_balances b
where not exists (select 1 from public.delivery_shortage_drafts f where f.delivery_id=b.delivery_id);

revoke all on public.agent_delivery_status, public.open_incoming_deliveries, public.open_delivery_balances from public, anon, authenticated;
grant select on public.agent_delivery_status, public.open_incoming_deliveries, public.open_delivery_balances to service_role;

-- The same lock serializes page and chat writers. A failed insert rolls back its stock movement.
create or replace function public.check_delivery_still_open() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.incoming_deliveries where delivery_id=new.delivery_id for update;
  if exists(select 1 from public.delivery_shortage_drafts where delivery_id=new.delivery_id) then
    raise exception 'DELIVERY_CLOSED_SHORT';
  end if;
  return new;
end $$;
drop trigger if exists check_delivery_still_open on public.delivery_receipts;
create trigger check_delivery_still_open before insert on public.delivery_receipts
for each row execute function public.check_delivery_still_open();
revoke all on function public.check_delivery_still_open() from public,anon,authenticated;
grant execute on function public.check_delivery_still_open() to service_role;

create or replace function public.receive_classified_delivery(
  p_request_id uuid, p_delivery_id bigint, p_amount numeric, p_expected_remaining numeric, p_note text, p_final boolean
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  receipt jsonb;
  previous_final boolean;
  shortage boolean;
begin
  if p_final is null then raise exception 'ARRIVAL_STATUS_REQUIRED'; end if;
  receipt := public.receive_inventory_delivery(p_request_id,p_delivery_id,p_amount,p_expected_remaining,p_note);
  if (receipt->>'replayed')::boolean then
    select is_final into previous_final from public.delivery_arrival_decisions where receipt_id=p_request_id;
    if coalesce(previous_final,false) <> p_final then raise exception 'RECEIPT_REQUEST_CONFLICT'; end if;
  else
    insert into public.delivery_arrival_decisions values (p_request_id,p_final);
    if p_final and (receipt->>'remaining')::numeric > 0 then
      insert into public.delivery_shortage_drafts(receipt_id,delivery_id,facts)
      select p_request_id,d.delivery_id,jsonb_build_object(
        'reference',coalesce(nullif(b.supplier_reference,''),'Delivery #' || d.delivery_id),
        'supplier',nullif(d.supplier_name,''),'ingredient',r.ingredient_name,'unit',r.unit,
        'ordered',d.quantity::text,'received',(d.quantity-r.remaining_after)::text,
        'missing',r.remaining_after::text,'stockAfter',r.stock_after::text,'minimum',i.minimum_stock::text)
      from public.incoming_deliveries d join public.delivery_receipts r on r.id=p_request_id
      join public.inventory i on i.ingredient_id=d.ingredient_id
      left join public.delivery_batches b on b.id=d.batch_id where d.delivery_id=p_delivery_id;
    end if;
  end if;
  select exists(select 1 from public.delivery_shortage_drafts where receipt_id=p_request_id) into shortage;
  return receipt || jsonb_build_object('closed_short',shortage);
end $$;
revoke all on function public.receive_classified_delivery(uuid,bigint,numeric,numeric,text,boolean) from public,anon,authenticated;
grant execute on function public.receive_classified_delivery(uuid,bigint,numeric,numeric,text,boolean) to service_role;

-- PostgreSQL evaluates all ingredients against the same stock snapshot.
create or replace function public.drink_capacity(p_product text) returns jsonb
language sql stable security invoker set search_path='' as $$
with parts as (
  select r.ingredient_id,i.ingredient_name,i.unit,r.quantity_required,
    s.quantity_in_stock, count(*) over (partition by r.ingredient_id) as copies
  from public.recipes r left join public.ingredients i using (ingredient_id)
  left join public.inventory s using (ingredient_id) where r.product_name=p_product
), checked as (
  select *, case when copies=1 and nullif(trim(ingredient_name),'') is not null and nullif(trim(unit),'') is not null
    and quantity_in_stock>=0 and quantity_required>0 and quantity_required<=1000000000
    and quantity_required=trunc(quantity_required,6)
    and quantity_required::text not in ('NaN','Infinity','-Infinity')
    and quantity_in_stock::text not in ('NaN','Infinity','-Infinity')
    then div(quantity_in_stock,quantity_required) end as servings from parts
), totals as (
  select count(*) as n, count(servings) as valid, min(servings) as capacity from checked
)
select case when n=0 then jsonb_build_object('status','unknown_product','product',p_product)
  when valid<>n then jsonb_build_object('status','incomplete_recipe_or_stock','product',p_product)
  else jsonb_build_object('status','ready','product',p_product,'wholeDrinks',capacity::text,
    'limitingIngredients',(select jsonb_agg(jsonb_build_object('name',ingredient_name,'onHand',quantity_in_stock::text,
      'perDrink',quantity_required::text,'unit',unit) order by ingredient_id) from checked where servings=capacity))
  end from totals
$$;
revoke all on function public.drink_capacity(text) from public,anon,authenticated;
grant execute on function public.drink_capacity(text) to service_role;
commit;
