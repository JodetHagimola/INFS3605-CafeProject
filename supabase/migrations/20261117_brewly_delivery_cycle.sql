-- Workstream C: idempotent delivery windows, simulated arrivals, and followups.
-- Validate against Supabase before applying. This migration does not seed stock.
begin;

alter table public.suppliers
  add column if not exists delivery_window_start time,
  add column if not exists delivery_window_end time;

alter table public.suppliers
  drop constraint if exists suppliers_delivery_window_check;
alter table public.suppliers
  add constraint suppliers_delivery_window_check
  check (
    (delivery_window_start is null and delivery_window_end is null)
    or (delivery_window_start is not null and delivery_window_end is not null
      and delivery_window_start < delivery_window_end)
  );

alter table public.incoming_deliveries
  add column if not exists arrival_checked_for date,
  add column if not exists arrival_checked_at timestamptz,
  add column if not exists arrival_result text;
alter table public.incoming_deliveries
  drop constraint if exists incoming_deliveries_arrival_result_check;
alter table public.incoming_deliveries
  add constraint incoming_deliveries_arrival_result_check
  check (arrival_result is null or arrival_result in ('complete', 'short', 'late'));

alter table public.cafe_sensor_events
  add column if not exists source text not null default 'simulated';
alter table public.cafe_sensor_events
  drop constraint if exists cafe_sensor_events_source_check;
alter table public.cafe_sensor_events
  add constraint cafe_sensor_events_source_check
  check (source in ('simulated', 'manual'));

-- Keep cafe_test_mail as the single queue, while allowing a chase with no receipt.
alter table public.cafe_test_mail
  add column if not exists sensor_event_id uuid,
  add column if not exists delivery_id bigint,
  add column if not exists purpose text not null default 'arrival_shortage',
  add column if not exists attempt smallint not null default 1;

update public.cafe_test_mail mail
set sensor_event_id = coalesce(mail.sensor_event_id, mail.event_id),
    delivery_id = coalesce(mail.delivery_id, event.delivery_id),
    purpose = case event.outcome when 'extra' then 'arrival_extra' else 'arrival_shortage' end
from public.cafe_sensor_events event
where event.id = mail.event_id;

alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_event_id_fkey;
alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_sensor_event_id_fkey;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_sensor_event_id_fkey
  foreign key (sensor_event_id) references public.cafe_sensor_events(id);
alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_delivery_id_fkey;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_delivery_id_fkey
  foreign key (delivery_id) references public.incoming_deliveries(delivery_id);
alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_purpose_check;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_purpose_check
  check (purpose in ('arrival_shortage', 'arrival_extra', 'delivery_chase'));
alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_attempt_check;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_attempt_check
  check (attempt between 0 and 2);

alter table public.owner_notifications
  add column if not exists dedupe_key text;
create unique index if not exists owner_notifications_dedupe_key_uidx
  on public.owner_notifications(dedupe_key)
  where dedupe_key is not null;

create or replace view public.agent_delivery_status with (security_invoker = true) as
select
  d.delivery_id,
  d.ingredient_id,
  d.quantity,
  d.expected_date,
  d.demo_key,
  d.batch_id,
  d.ordered_quantity,
  d.supplier_name,
  d.stock_unit,
  (
    d.status <> 'received'
    and exists (
      select 1
      from public.delivery_shortage_drafts draft
      join public.delivery_arrival_decisions decision
        on decision.receipt_id = draft.receipt_id
      where draft.delivery_id = d.delivery_id
        and decision.is_final
    )
  ) as closed_short,
  d.status,
  d.closed_at,
  d.closed_reason,
  d.chase_count,
  d.last_chased_at,
  d.source
from public.incoming_deliveries d;

create or replace view public.open_incoming_deliveries with (security_invoker = true) as
select *
from public.agent_delivery_status
where not closed_short and status in ('expected', 'partially_received');

create or replace view public.open_delivery_balances with (security_invoker = true) as
select b.*
from public.inventory_delivery_balances b
join public.incoming_deliveries d using (delivery_id)
where d.status in ('expected', 'partially_received')
  and not exists (
    select 1
    from public.delivery_shortage_drafts draft
    join public.delivery_arrival_decisions decision
      on decision.receipt_id = draft.receipt_id
    where draft.delivery_id = b.delivery_id
      and decision.is_final
  );

create or replace function public.check_delivery_still_open()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
  from public.incoming_deliveries
  where delivery_id = new.delivery_id
  for update;
  if exists (
    select 1
    from public.delivery_shortage_drafts draft
    join public.delivery_arrival_decisions decision
      on decision.receipt_id = draft.receipt_id
    where draft.delivery_id = new.delivery_id
      and decision.is_final
  ) then
    raise exception 'DELIVERY_CLOSED_SHORT';
  end if;
  return new;
end;
$$;
drop trigger if exists check_delivery_still_open on public.delivery_receipts;
create trigger check_delivery_still_open
before insert on public.delivery_receipts
for each row execute function public.check_delivery_still_open();
revoke all on function public.check_delivery_still_open() from public, anon, authenticated;
grant execute on function public.check_delivery_still_open() to service_role;

create or replace function public.receive_classified_delivery(
  p_request_id uuid,
  p_delivery_id bigint,
  p_amount numeric,
  p_expected_remaining numeric,
  p_note text,
  p_final boolean
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_receipt jsonb;
  v_previous_final boolean;
  v_shortage boolean;
begin
  if p_final is null then
    raise exception 'ARRIVAL_STATUS_REQUIRED';
  end if;

  v_receipt := public.receive_inventory_delivery(
    p_request_id, p_delivery_id, p_amount, p_expected_remaining, p_note
  );
  if (v_receipt ->> 'replayed')::boolean then
    select is_final into v_previous_final
    from public.delivery_arrival_decisions
    where receipt_id = p_request_id;
    if coalesce(v_previous_final, false) <> p_final then
      raise exception 'RECEIPT_REQUEST_CONFLICT';
    end if;
  else
    insert into public.delivery_arrival_decisions(receipt_id, is_final)
    values (p_request_id, p_final);

    if p_final and (v_receipt ->> 'remaining')::numeric > 0 then
      insert into public.delivery_shortage_drafts(receipt_id, delivery_id, facts)
      select
        p_request_id,
        d.delivery_id,
        jsonb_build_object(
          'reference', coalesce(nullif(b.supplier_reference, ''), 'Delivery #' || d.delivery_id),
          'supplier', nullif(d.supplier_name, ''),
          'ingredient', r.ingredient_name,
          'unit', r.unit,
          'ordered', d.quantity::text,
          'received', (d.quantity - r.remaining_after)::text,
          'missing', r.remaining_after::text,
          'stockAfter', r.stock_after::text,
          'minimum', i.minimum_stock::text
        )
      from public.incoming_deliveries d
      join public.delivery_receipts r on r.id = p_request_id
      join public.inventory i on i.ingredient_id = d.ingredient_id
      left join public.delivery_batches b on b.id = d.batch_id
      where d.delivery_id = p_delivery_id
      on conflict (delivery_id) do update
      set receipt_id = excluded.receipt_id,
          facts = excluded.facts;
    end if;
  end if;

  select exists (
    select 1
    from public.delivery_shortage_drafts
    where receipt_id = p_request_id
  ) into v_shortage;

  return v_receipt || jsonb_build_object('closed_short', v_shortage);
end;
$$;
revoke all on function public.receive_classified_delivery(uuid, bigint, numeric, numeric, text, boolean)
  from public, anon, authenticated;
grant execute on function public.receive_classified_delivery(uuid, bigint, numeric, numeric, text, boolean)
  to service_role;

create or replace function public.record_simulated_delivery_arrival(
  p_event uuid,
  p_delivery_id bigint,
  p_expected_date date,
  p_measured numeric,
  p_expected numeric,
  p_unit text,
  p_result text,
  p_checked_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_delivery public.incoming_deliveries%rowtype;
  v_result jsonb;
begin
  if p_event is null or p_delivery_id is null or p_expected_date is null
    or p_measured is null or p_expected is null or p_unit is null or p_result is null
    or p_result not in ('complete', 'short') or p_checked_at is null then
    raise exception 'INVALID_SIMULATED_ARRIVAL';
  end if;
  if exists (select 1 from public.cafe_settings where id = 1 and automation_paused) then
    return jsonb_build_object('status', 'paused');
  end if;

  select * into v_delivery
  from public.incoming_deliveries
  where delivery_id = p_delivery_id
  for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND'; end if;
  if v_delivery.status not in ('expected', 'partially_received') then
    raise exception 'DELIVERY_NOT_OPEN';
  end if;
  if v_delivery.expected_date is distinct from p_expected_date then
    raise exception 'DELIVERY_DATE_CHANGED';
  end if;
  if v_delivery.arrival_checked_for = p_expected_date then
    return jsonb_build_object(
      'status', 'already_checked',
      'outcome', v_delivery.arrival_result,
      'checked_at', v_delivery.arrival_checked_at
    );
  end if;

  v_result := public.apply_sensor_reading(
    p_event, p_delivery_id, p_measured, p_expected, p_unit, false
  );
  if p_result = 'complete' and v_result ->> 'outcome' <> 'complete' then
    raise exception 'SIMULATED_ARRIVAL_RESULT_MISMATCH';
  end if;
  if p_result = 'short' and v_result ->> 'outcome' not in ('partial', 'short') then
    raise exception 'SIMULATED_ARRIVAL_RESULT_MISMATCH';
  end if;

  update public.cafe_sensor_events
  set source = 'simulated', outcome = p_result
  where id = p_event and delivery_id = p_delivery_id;
  if not found then raise exception 'SENSOR_EVENT_NOT_FOUND'; end if;

  update public.incoming_deliveries
  set arrival_checked_for = p_expected_date,
      arrival_checked_at = p_checked_at,
      arrival_result = p_result
  where delivery_id = p_delivery_id;

  insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
  values (
    'simulated_delivery_arrival',
    jsonb_build_object('delivery_id', p_delivery_id, 'event_id', p_event, 'outcome', p_result)::text,
    'success',
    case p_result
      when 'complete' then 'Simulated arrival recorded within the expected quantity tolerance.'
      else 'Simulated short arrival recorded; the remaining quantity stays expected.'
    end,
    'delivery_cycle'
  );

  return v_result || jsonb_build_object('outcome', p_result, 'replayed', false);
end;
$$;

create or replace function public.record_simulated_delivery_late(
  p_delivery_id bigint,
  p_expected_date date,
  p_checked_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_delivery public.incoming_deliveries%rowtype;
begin
  if p_delivery_id is null or p_expected_date is null or p_checked_at is null then
    raise exception 'INVALID_SIMULATED_ARRIVAL';
  end if;
  if exists (select 1 from public.cafe_settings where id = 1 and automation_paused) then
    return jsonb_build_object('status', 'paused');
  end if;
  select * into v_delivery
  from public.incoming_deliveries
  where delivery_id = p_delivery_id
  for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND'; end if;
  if v_delivery.status not in ('expected', 'partially_received') then
    raise exception 'DELIVERY_NOT_OPEN';
  end if;
  if v_delivery.expected_date is distinct from p_expected_date then
    raise exception 'DELIVERY_DATE_CHANGED';
  end if;
  if v_delivery.arrival_checked_for = p_expected_date then
    return jsonb_build_object(
      'status', 'already_checked',
      'outcome', v_delivery.arrival_result,
      'checked_at', v_delivery.arrival_checked_at
    );
  end if;

  update public.incoming_deliveries
  set arrival_checked_for = p_expected_date,
      arrival_checked_at = p_checked_at,
      arrival_result = 'late'
  where delivery_id = p_delivery_id;

  insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
  values (
    'simulated_delivery_arrival',
    jsonb_build_object('delivery_id', p_delivery_id, 'outcome', 'late')::text,
    'success',
    'No goods were recorded; the simulated supplier arrival is late.',
    'delivery_cycle'
  );
  return jsonb_build_object('status', 'recorded', 'outcome', 'late', 'replayed', false);
end;
$$;

create or replace function public.save_delivery_shortage_followup(
  p_event uuid,
  p_delivery_id bigint,
  p_draft_facts jsonb,
  p_mail_facts jsonb,
  p_mail_payload jsonb,
  p_needs_owner boolean,
  p_notification_title text,
  p_notification_body text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.cafe_sensor_events%rowtype;
  v_receipt_id uuid;
begin
  if p_event is null or p_delivery_id is null
    or jsonb_typeof(p_draft_facts) <> 'object'
    or jsonb_typeof(p_mail_facts) <> 'object'
    or jsonb_typeof(p_mail_payload) <> 'object'
    or p_needs_owner is null
    or length(btrim(coalesce(p_notification_title, ''))) > 120
    or length(coalesce(p_notification_body, '')) > 1000 then
    raise exception 'INVALID_DELIVERY_FOLLOWUP';
  end if;
  if exists (select 1 from public.cafe_settings where id = 1 and automation_paused) then
    return jsonb_build_object('status', 'paused');
  end if;

  select * into v_event
  from public.cafe_sensor_events
  where id = p_event and delivery_id = p_delivery_id
  for update;
  if not found or v_event.outcome <> 'short' then
    raise exception 'SHORT_ARRIVAL_NOT_FOUND';
  end if;

  select id into v_receipt_id
  from public.delivery_receipts
  where id = v_event.receipt_id;
  if not found then raise exception 'SHORT_ARRIVAL_RECEIPT_NOT_FOUND'; end if;

  insert into public.delivery_shortage_drafts(receipt_id, delivery_id, facts)
  values (v_receipt_id, p_delivery_id, p_draft_facts)
  on conflict (delivery_id) do update
  set receipt_id = excluded.receipt_id, facts = excluded.facts;

  insert into public.cafe_test_mail(
    event_id, sensor_event_id, delivery_id, purpose, attempt, facts,
    payload, channel, status, provider_id, sent_at, last_error
  )
  values (
    p_event, p_event, p_delivery_id, 'arrival_shortage', 0, p_mail_facts,
    p_mail_payload, 'inbox', 'delivered_to_demo', p_event::text, clock_timestamp(), null
  )
  on conflict (event_id) do update
  set facts = excluded.facts,
      payload = excluded.payload,
      channel = excluded.channel,
      status = excluded.status,
      provider_id = excluded.provider_id,
      sent_at = excluded.sent_at,
      last_error = null;

  if p_needs_owner then
    insert into public.owner_notifications(
      severity, title, body, surface_after, channel, status, dedupe_key
    )
    values (
      'decision', p_notification_title, p_notification_body, clock_timestamp(),
      'in_app', 'pending', 'delivery-shortage:' || p_delivery_id::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return jsonb_build_object('status', 'saved', 'delivery_id', p_delivery_id, 'needs_owner', p_needs_owner);
end;
$$;

create or replace function public.apply_delivery_followup(
  p_delivery_id bigint,
  p_today date,
  p_now timestamptz,
  p_action text,
  p_mail_event uuid,
  p_mail_facts jsonb,
  p_mail_payload jsonb,
  p_notification_title text,
  p_notification_body text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_delivery public.incoming_deliveries%rowtype;
  v_attempt smallint;
  v_dedupe_key text;
begin
  if p_delivery_id is null or p_today is null or p_now is null
    or p_action is null or p_action not in ('chase', 'decision', 'lapse') then
    raise exception 'INVALID_DELIVERY_FOLLOWUP';
  end if;
  if exists (select 1 from public.cafe_settings where id = 1 and automation_paused) then
    return jsonb_build_object('status', 'paused');
  end if;
  select * into v_delivery
  from public.incoming_deliveries
  where delivery_id = p_delivery_id
  for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND'; end if;
  if v_delivery.status not in ('expected', 'partially_received') then
    return jsonb_build_object('status', 'not_open');
  end if;

  if p_action = 'lapse' then
    if p_today < v_delivery.expected_date + 7 then
      raise exception 'DELIVERY_NOT_READY_TO_LAPSE';
    end if;
    update public.incoming_deliveries
    set status = 'lapsed',
        closed_at = p_now,
        closed_reason = 'No receipt recorded seven days after the expected date'
    where delivery_id = p_delivery_id;
    v_dedupe_key := 'delivery-lapsed:' || p_delivery_id::text;
    insert into public.owner_notifications(
      severity, title, body, surface_after, channel, status, dedupe_key
    )
    values (
      'decision', p_notification_title, p_notification_body, p_now,
      'in_app', 'pending', v_dedupe_key
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
    values (
      'delivery_lapse',
      jsonb_build_object('delivery_id', p_delivery_id)::text,
      'success',
      'Delivery lapsed after seven days with no recorded receipt; a replacement decision is needed.',
      'delivery_cycle'
    );
    return jsonb_build_object('status', 'lapsed', 'delivery_id', p_delivery_id);
  end if;

  if p_today <= v_delivery.expected_date then
    return jsonb_build_object('status', 'not_overdue');
  end if;
  if v_delivery.last_chased_at is not null
    and p_now < v_delivery.last_chased_at + interval '24 hours' then
    return jsonb_build_object('status', 'waiting_for_next_check');
  end if;

  if p_action = 'chase' then
    if p_mail_event is null or jsonb_typeof(p_mail_facts) <> 'object'
      or jsonb_typeof(p_mail_payload) <> 'object' or v_delivery.chase_count >= 2 then
      return jsonb_build_object('status', 'chase_not_eligible');
    end if;
    v_attempt := (v_delivery.chase_count + 1)::smallint;
    insert into public.cafe_test_mail(
      event_id, sensor_event_id, delivery_id, purpose, attempt, facts,
      payload, channel, status, provider_id, sent_at, last_error
    )
    values (
      p_mail_event, null, p_delivery_id, 'delivery_chase', v_attempt, p_mail_facts,
      p_mail_payload, 'inbox', 'delivered_to_demo', p_mail_event::text, p_now, null
    )
    on conflict (event_id) do nothing;
    update public.incoming_deliveries
    set chase_count = v_attempt,
        last_chased_at = p_now
    where delivery_id = p_delivery_id;
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
    values (
      'delivery_chase',
      jsonb_build_object('delivery_id', p_delivery_id, 'attempt', v_attempt)::text,
      'success',
      'A supplier chase was added to the test mailbox; no external email was sent.',
      'delivery_cycle'
    );
    return jsonb_build_object('status', 'chase_queued', 'attempt', v_attempt);
  end if;

  if v_delivery.chase_count < 2 or p_notification_title is null
    or p_notification_body is null then
    return jsonb_build_object('status', 'decision_not_eligible');
  end if;
  v_dedupe_key := 'delivery-late-decision:' || p_delivery_id::text;
  insert into public.owner_notifications(
    severity, title, body, surface_after, channel, status, dedupe_key
  )
  values (
    'decision', p_notification_title, p_notification_body, p_now,
    'in_app', 'pending', v_dedupe_key
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
  values (
    'delivery_chase_decision',
    jsonb_build_object('delivery_id', p_delivery_id, 'chase_count', v_delivery.chase_count)::text,
    'success',
    'Two supplier chases have not resolved the overdue delivery; an owner decision is waiting.',
    'delivery_cycle'
  );
  return jsonb_build_object('status', 'decision_queued', 'delivery_id', p_delivery_id);
end;
$$;

grant select, insert, update on public.cafe_sensor_events, public.cafe_test_mail,
  public.delivery_shortage_drafts, public.owner_notifications,
  public.incoming_deliveries, public.agent_activity to service_role;
revoke all on function public.record_simulated_delivery_arrival(uuid, bigint, date, numeric, numeric, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_simulated_delivery_arrival(uuid, bigint, date, numeric, numeric, text, text, timestamptz)
  to service_role;
revoke all on function public.record_simulated_delivery_late(bigint, date, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_simulated_delivery_late(bigint, date, timestamptz)
  to service_role;
revoke all on function public.save_delivery_shortage_followup(uuid, bigint, jsonb, jsonb, jsonb, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.save_delivery_shortage_followup(uuid, bigint, jsonb, jsonb, jsonb, boolean, text, text)
  to service_role;
revoke all on function public.apply_delivery_followup(bigint, date, timestamptz, text, uuid, jsonb, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_delivery_followup(bigint, date, timestamptz, text, uuid, jsonb, jsonb, text, text)
  to service_role;

commit;
