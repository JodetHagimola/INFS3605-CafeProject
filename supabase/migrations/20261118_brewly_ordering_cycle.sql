-- Workstream D: idempotent ordering decisions and test-mail deduplication.
-- Review against the live schema before applying. This migration sends no email
-- and does not create or change any order or inventory rows.
begin;

create table if not exists public.cafe_ordering_cycles (
  cycle_key text primary key check (length(btrim(cycle_key)) between 1 and 200),
  supplier text,
  status text not null check (status in (
    'processing', 'approval_required', 'simulated_order', 'blocked', 'no_action'
  )),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  draft_id uuid references public.draft_orders(id),
  approval_id uuid references public.approval_inbox(id),
  batch_id uuid references public.delivery_batches(id),
  email_event_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.cafe_test_mail
  add column if not exists dedupe_key text;

alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_purpose_check;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_purpose_check
  check (purpose in ('arrival_shortage', 'arrival_extra', 'delivery_chase', 'order_confirmation'));

create unique index if not exists cafe_test_mail_dedupe_key_uidx
  on public.cafe_test_mail(dedupe_key);

alter table public.cafe_ordering_cycles enable row level security;
revoke all on public.cafe_ordering_cycles from public, anon, authenticated;
grant select, insert, update on public.cafe_ordering_cycles to service_role;

create or replace function public.register_order_delivery(
  p_draft_id uuid, p_expected_date date, p_reference text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_draft public.draft_orders%rowtype;
  v_batch public.delivery_batches%rowtype;
  v_line jsonb;
  v_line_index integer;
  v_id bigint;
  v_quantity numeric;
  v_unit text;
  v_supplier text;
  v_line_expected_date date;
begin
  if p_draft_id is null or p_expected_date is null or p_reference is null
    or length(btrim(p_reference)) not between 1 and 120 then raise exception 'INVALID_DELIVERY'; end if;
  select * into v_draft from public.draft_orders where id = p_draft_id for update;
  if not found or v_draft.status <> 'approved' then raise exception 'ORDER_NOT_APPROVED'; end if;
  select * into v_batch from public.delivery_batches where draft_id = p_draft_id;
  if found then
    if v_batch.expected_date <> p_expected_date or v_batch.supplier_reference <> btrim(p_reference) then
      raise exception 'ORDER_ALREADY_REGISTERED';
    end if;
    return jsonb_build_object('batch_id', v_batch.id, 'replayed', true);
  end if;
  if jsonb_typeof(v_draft.lines) is distinct from 'array'
    or jsonb_array_length(v_draft.lines) not between 1 and 100 then raise exception 'INVALID_ORDER_LINES'; end if;
  insert into public.delivery_batches(draft_id, expected_date, supplier_reference)
    values (p_draft_id, p_expected_date, btrim(p_reference)) returning * into v_batch;
  for v_line in select value from jsonb_array_elements(v_draft.lines) loop
    if coalesce(v_line->>'ingredientId','') !~ '^[0-9]{1,18}$'
      or coalesce(v_line->>'recommendedOrderQuantity','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or (v_line ? 'expectedDate' and coalesce(v_line->>'expectedDate','') !~ '^\d{4}-\d{2}-\d{2}$') then
      raise exception 'INVALID_ORDER_LINES';
    end if;
    v_id := (v_line->>'ingredientId')::bigint;
    v_quantity := (v_line->>'recommendedOrderQuantity')::numeric;
    v_supplier := v_line->'recommendedSupplier'->>'supplier';
    v_line_expected_date := coalesce((v_line->>'expectedDate')::date, p_expected_date);
    if v_quantity <= 0 or v_quantity > 1000000000 or v_supplier is null
      or length(btrim(v_supplier)) not between 1 and 120
      or v_line_expected_date < p_expected_date - 365
      or v_line_expected_date > p_expected_date then raise exception 'INVALID_ORDER_LINES'; end if;
    select unit into v_unit from public.ingredients where ingredient_id = v_id;
    if not found or v_unit is null or btrim(v_unit) = ''
      or v_unit is distinct from v_line->>'unit' then raise exception 'ORDER_UNIT_MISMATCH'; end if;
    if not exists(select 1 from public.inventory where ingredient_id = v_id) then raise exception 'NO_STOCK_RECORD'; end if;
    if exists(select 1 from public.incoming_deliveries where batch_id = v_batch.id and ingredient_id = v_id) then
      raise exception 'INVALID_ORDER_LINES';
    end if;
    insert into public.incoming_deliveries(
      ingredient_id, quantity, ordered_quantity, expected_date, batch_id, supplier_name, stock_unit, source
    ) values (
      v_id, v_quantity, v_quantity, v_line_expected_date, v_batch.id, v_supplier, v_unit, 'order'
    );
  end loop;
  return jsonb_build_object('batch_id', v_batch.id, 'replayed', false);
end;
$$;

create or replace function public.apply_cafe_ordering_cycle(
  p_cycle_key text,
  p_supplier text,
  p_draft_id uuid,
  p_approval_id uuid,
  p_email_event_id uuid,
  p_auto_eligible boolean,
  p_plan jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.cafe_ordering_cycles%rowtype;
  v_settings public.cafe_settings%rowtype;
  v_policy public.cafe_spend_policy%rowtype;
  v_line jsonb;
  v_mail_line jsonb;
  v_line_index integer;
  v_draft jsonb;
  v_status text;
  v_flags jsonb;
  v_cycle_date date;
  v_expected_date date;
  v_total_cents bigint;
  v_total numeric;
  v_line_total_cents bigint := 0;
  v_spent_today numeric;
  v_spent_week numeric;
  v_batch_id uuid;
  v_reference text;
  v_summary text;
  v_approval_details jsonb;
  v_auto boolean;
begin
  if p_cycle_key is null or length(btrim(p_cycle_key)) not between 1 and 200
    or p_supplier is null or length(btrim(p_supplier)) not between 1 and 120
    or p_draft_id is null or p_approval_id is null or p_email_event_id is null
    or p_auto_eligible is null or jsonb_typeof(p_plan) is distinct from 'object'
    or coalesce(p_plan->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
    or coalesce(p_plan->>'expectedDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    or coalesce(p_plan->>'reference','') !~ '^[A-Za-z0-9-]{1,120}$'
    or coalesce(p_plan->>'totalCents','') !~ '^(0|[1-9][0-9]{0,15})$'
    or p_plan->>'supplier' is distinct from p_supplier
    or jsonb_typeof(p_plan->'lines') is distinct from 'array'
    or jsonb_array_length(p_plan->'lines') not between 1 and 100
    or jsonb_typeof(p_plan->'flags') is distinct from 'array'
    or jsonb_typeof(p_plan->'draft') is distinct from 'object'
    or jsonb_typeof(p_plan->'mailFacts') is distinct from 'object'
    or p_plan->'mailFacts'->>'kind' is distinct from 'order'
    or p_plan->'mailFacts'->>'reference' is distinct from p_plan->>'reference'
    or p_plan->'mailFacts'->>'supplier' is distinct from p_supplier
    or p_plan->'mailFacts'->>'totalCents' is distinct from p_plan->>'totalCents'
    or jsonb_typeof(p_plan->'mailFacts'->'lines') is distinct from 'array'
    or jsonb_array_length(p_plan->'mailFacts'->'lines') <> jsonb_array_length(p_plan->'lines') then
    raise exception 'INVALID_ORDERING_CYCLE';
  end if;

  v_cycle_date := (p_plan->>'date')::date;
  v_expected_date := (p_plan->>'expectedDate')::date;
  v_total_cents := (p_plan->>'totalCents')::bigint;
  v_total := v_total_cents::numeric / 100;
  v_reference := p_plan->>'reference';
  v_draft := p_plan->'draft';
  if v_total_cents < 0 or v_expected_date < v_cycle_date or v_expected_date > v_cycle_date + 365
    or coalesce(v_draft->>'forecastDate','') <> v_cycle_date::text
    or jsonb_typeof(v_draft->'lines') is distinct from 'array'
    or jsonb_array_length(v_draft->'lines') <> jsonb_array_length(p_plan->'lines') then
    raise exception 'INVALID_ORDERING_CYCLE';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_cycle_key, 1));
  select * into v_existing from public.cafe_ordering_cycles
    where cycle_key = p_cycle_key for update;
  if found then
    return jsonb_build_object(
      'status', v_existing.status,
      'draft_id', v_existing.draft_id,
      'approval_id', v_existing.approval_id,
      'batch_id', v_existing.batch_id,
      'email_event_id', v_existing.email_event_id,
      'replayed', true
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cafe-ordering-budget', 1)
  );
  select * into strict v_settings from public.cafe_settings where id = 1 for update;
  select * into strict v_policy from public.cafe_spend_policy where id = 1 for update;
  if v_settings.automation_paused or v_settings.email_mode <> 'test' then
    return jsonb_build_object('status', 'paused', 'replayed', false);
  end if;

  select coalesce(sum(o.total), 0) into v_spent_today
  from public.cafe_sim_orders o
  where o.status = 'submitted'
    and (o.submitted_at at time zone 'Australia/Sydney')::date = v_cycle_date;
  select v_spent_today + coalesce(sum((c.plan->>'totalCents')::numeric / 100), 0)
    into v_spent_today
  from public.cafe_ordering_cycles c
  where c.status = 'simulated_order'
    and (c.created_at at time zone 'Australia/Sydney')::date = v_cycle_date;

  select coalesce(sum(o.total), 0) into v_spent_week
  from public.cafe_sim_orders o
  where o.status = 'submitted'
    and (o.submitted_at at time zone 'Australia/Sydney')::date >= date_trunc('week', v_cycle_date::timestamp)::date
    and (o.submitted_at at time zone 'Australia/Sydney')::date <= v_cycle_date;
  select v_spent_week + coalesce(sum((c.plan->>'totalCents')::numeric / 100), 0)
    into v_spent_week
  from public.cafe_ordering_cycles c
  where c.status = 'simulated_order'
    and (c.created_at at time zone 'Australia/Sydney')::date >= date_trunc('week', v_cycle_date::timestamp)::date
    and (c.created_at at time zone 'Australia/Sydney')::date <= v_cycle_date;

  v_flags := coalesce(p_plan->'flags', '[]'::jsonb);
  v_auto := p_auto_eligible;
  if v_total > v_policy.auto_order_limit then
    v_auto := false;
    v_flags := v_flags || jsonb_build_array('Order exceeds the current automatic per-order limit.');
  end if;
  if v_spent_today + v_total > v_policy.daily_limit then
    v_auto := false;
    v_flags := v_flags || jsonb_build_array('Order would exceed the current daily spend limit.');
  end if;
  if v_policy.weekly_limit is not null and v_spent_week + v_total > v_policy.weekly_limit then
    v_auto := false;
    v_flags := v_flags || jsonb_build_array('Order would exceed the current weekly spend limit.');
  end if;

  for v_line, v_line_index in
    select value, ordinality::integer
    from jsonb_array_elements(p_plan->'lines') with ordinality
  loop
    if coalesce(v_line->>'ingredientId','') !~ '^[0-9]{1,18}$'
      or coalesce(v_line->>'packs','') !~ '^[1-9][0-9]{0,4}$'
      or coalesce(v_line->>'quantity','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'packSize','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'unitPrice','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'minimumOrder','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'currentStock','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'minimum','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'incomingByDate','') !~ '^[0-9]+(\.[0-9]{1,6})?$'
      or coalesce(v_line->>'totalCents','') !~ '^(0|[1-9][0-9]{0,15})$'
      or coalesce(v_line->>'expectedDate','') !~ '^\d{4}-\d{2}-\d{2}$'
      or (v_line->>'expectedDate')::date > v_expected_date then
      raise exception 'INVALID_ORDERING_LINE';
    end if;
    if v_line->>'ingredientId' is distinct from (v_draft->'lines'->(v_line_index - 1)->>'ingredientId')
      or (v_line->>'quantity')::numeric is distinct from
        ((v_draft->'lines'->(v_line_index - 1)->>'recommendedOrderQuantity')::numeric)
      or v_line->>'expectedDate' is distinct from (v_draft->'lines'->(v_line_index - 1)->>'expectedDate') then
      raise exception 'ORDERING_DRAFT_MISMATCH';
    end if;
    v_mail_line := p_plan->'mailFacts'->'lines'->(v_line_index - 1);
    if v_mail_line->>'ingredient' is distinct from v_line->>'ingredient'
      or v_mail_line->>'unit' is distinct from v_line->>'unit'
      or v_mail_line->>'quantity' is distinct from v_line->>'quantity'
      or v_mail_line->>'packs' is distinct from v_line->>'packs'
      or v_mail_line->>'packLabel' is distinct from v_line->>'packLabel'
      or v_mail_line->>'unitPrice' is distinct from v_line->>'unitPrice'
      or v_mail_line->>'expectedDate' is distinct from v_line->>'expectedDate' then
      raise exception 'ORDERING_MAIL_MISMATCH';
    end if;
    perform 1 from public.inventory
      where ingredient_id = (v_line->>'ingredientId')::bigint for update;
    perform 1 from public.supplier_prices
      where ingredient_id = (v_line->>'ingredientId')::bigint and supplier = p_supplier for share;
    perform 1 from public.suppliers where name = p_supplier for share;
    perform 1 from public.cafe_reorder_rules
      where ingredient_id = (v_line->>'ingredientId')::bigint and supplier = p_supplier for share;
    if not exists (
      select 1
      from public.supplier_prices price
      join public.suppliers supplier on supplier.name = price.supplier
      join public.cafe_reorder_rules rule on rule.ingredient_id = price.ingredient_id
        and rule.supplier = price.supplier and rule.enabled
      join public.inventory stock on stock.ingredient_id = price.ingredient_id
      where price.ingredient_id = (v_line->>'ingredientId')::bigint
        and price.supplier = p_supplier
        and supplier.active and supplier.contact_email is not null
        and length(btrim(supplier.contact_email)) > 0
        and price.price = (v_line->>'unitPrice')::numeric
        and price.pack_size = (v_line->>'packSize')::numeric
        and price.minimum_order = (v_line->>'minimumOrder')::numeric
        and stock.quantity_in_stock = (v_line->>'currentStock')::numeric
        and stock.minimum_stock = (v_line->>'minimum')::numeric
        and (v_line->>'packSize')::numeric > 0
        and (v_line->>'quantity')::numeric = (v_line->>'packs')::numeric * price.pack_size
        and (v_line->>'quantity')::numeric >= price.minimum_order
        and round((v_line->>'quantity')::numeric * price.price * 100)::bigint
          = (v_line->>'totalCents')::bigint
        and coalesce((
          select sum(balance.outstanding_quantity)
          from public.open_delivery_balances balance
          where balance.ingredient_id = price.ingredient_id
            and balance.expected_date <= (v_line->>'expectedDate')::date
        ), 0) = (v_line->>'incomingByDate')::numeric
        and rule.packs >= 1
        and (v_line->>'packs')::integer <= rule.packs * 2
        and (v_line->>'totalCents')::bigint::numeric / 100 <= rule.order_limit
    ) then
      v_auto := false;
      v_flags := v_flags || jsonb_build_array('Supplier, quote, rule, or stock data changed; owner approval is required.');
    end if;
    v_line_total_cents := v_line_total_cents + (v_line->>'totalCents')::bigint;
  end loop;
  if v_line_total_cents <> v_total_cents then
    raise exception 'ORDERING_TOTAL_MISMATCH';
  end if;

  v_draft := jsonb_set(v_draft, '{flags}', v_flags, true);
  v_status := case when v_auto then 'simulated_order' else 'approval_required' end;

  insert into public.draft_orders(
    id, status, forecast_date, forecast, lines, flags, data_used, approved_at
  ) values (
    p_draft_id,
    case when v_auto then 'approved' else 'draft' end,
    (v_draft->>'forecastDate')::date,
    v_draft->'forecast',
    v_draft->'lines',
    v_flags,
    v_draft->'dataUsed',
    case when v_auto then clock_timestamp() else null end
  );

  if v_auto then
    perform public.register_order_delivery(p_draft_id, v_expected_date, v_reference);
    select id into strict v_batch_id from public.delivery_batches where draft_id = p_draft_id;
    insert into public.cafe_test_mail(
      event_id, delivery_id, purpose, attempt, facts, payload, channel, status, retry_at, dedupe_key
    ) values (
      p_email_event_id, null, 'order_confirmation', 1, p_plan->'mailFacts',
      null, null, 'queued', clock_timestamp(), 'order-confirmation:' || p_cycle_key
    );
    insert into public.owner_notifications(
      severity, title, body, surface_after, channel, status, dedupe_key
    ) values (
      'info',
      'Simulated supplier order registered',
      'Order ' || v_reference || ' for ' || p_supplier || ' was recorded and the supplier email was queued for test-mode delivery. No supplier was contacted.',
      clock_timestamp(),
      'in_app',
      'pending',
      'ordering-simulated:' || p_cycle_key
    ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
    values (
      'ordering_cycle',
      jsonb_build_object('cycle_key', p_cycle_key, 'supplier', p_supplier)::text,
      'success',
      'A simulated order was registered; its supplier email was queued for test mode only.',
      'ordering_cycle'
    );
  else
    v_approval_details := jsonb_build_object(
      'draftId', p_draft_id,
      'orderingCycleKey', p_cycle_key,
      'supplier', p_supplier,
      'estimatedTotal', v_total,
      'reason', array_to_string(array(select jsonb_array_elements_text(v_flags)), ' ')
    );
    v_summary := 'Review ' || jsonb_array_length(v_draft->'lines')::text
      || ' proposed order line(s) from ' || p_supplier || ' for $' || to_char(v_total, 'FM999999990.00') || '.';
    insert into public.approval_inbox(id, action, summary, details)
    values (p_approval_id, 'place_or_send_order', v_summary, v_approval_details);
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
    values (
      'ordering_cycle',
      jsonb_build_object('cycle_key', p_cycle_key, 'supplier', p_supplier)::text,
      'blocked',
      left('Owner approval is required before registering a simulated order. ' || array_to_string(array(select jsonb_array_elements_text(v_flags)), ' '), 1000),
      'ordering_cycle'
    );
  end if;

  insert into public.cafe_ordering_cycles(
    cycle_key, supplier, status, plan, draft_id, approval_id, batch_id, email_event_id
  ) values (
    p_cycle_key,
    p_supplier,
    v_status,
    p_plan || jsonb_build_object('autoEligible', v_auto, 'flags', v_flags),
    p_draft_id,
    case when v_auto then null else p_approval_id end,
    v_batch_id,
    case when v_auto then p_email_event_id else null end
  );
  return jsonb_build_object(
    'status', v_status,
    'draft_id', p_draft_id,
    'approval_id', case when v_auto then null else p_approval_id end,
    'batch_id', v_batch_id,
    'email_event_id', case when v_auto then p_email_event_id else null end,
    'replayed', false
  );
end;
$$;

revoke all on function public.register_order_delivery(uuid,date,text) from public, anon, authenticated;
grant execute on function public.register_order_delivery(uuid,date,text) to service_role;
revoke all on function public.apply_cafe_ordering_cycle(text,text,uuid,uuid,uuid,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.apply_cafe_ordering_cycle(text,text,uuid,uuid,uuid,boolean,jsonb) to service_role;

commit;
