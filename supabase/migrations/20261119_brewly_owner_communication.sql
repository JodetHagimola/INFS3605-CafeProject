-- Workstream E: quiet-window notifications and single-use owner digest links.
-- Apply only after reviewing against the live Workstream D schema.
begin;

alter table public.approval_tokens
  add column if not exists action text not null default 'approve';
alter table public.approval_tokens
  drop constraint if exists approval_tokens_action_check;
alter table public.approval_tokens
  add constraint approval_tokens_action_check check (action in ('approve', 'edit'));

alter table public.cafe_test_mail
  drop constraint if exists cafe_test_mail_purpose_check;
alter table public.cafe_test_mail
  add constraint cafe_test_mail_purpose_check
  check (purpose in ('arrival_shortage', 'arrival_extra', 'delivery_chase', 'order_confirmation', 'owner_digest'));

create table if not exists public.owner_digest_runs (
  id uuid primary key default gen_random_uuid(),
  digest_date date not null,
  slot text not null check (slot in ('pre_open', 'wrap_up')),
  email_event_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp(),
  unique (digest_date, slot)
);

create table if not exists public.automation_cycle_runs (
  id uuid primary key default gen_random_uuid(),
  cycle text not null check (cycle in ('orders', 'deliveries', 'thresholds')),
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
create index if not exists automation_cycle_runs_running_idx
  on public.automation_cycle_runs(started_at desc) where status = 'running';

alter table public.owner_digest_runs enable row level security;
revoke all on public.owner_digest_runs from public, anon, authenticated;
grant select, insert on public.owner_digest_runs to service_role;
alter table public.automation_cycle_runs enable row level security;
revoke all on public.automation_cycle_runs from public, anon, authenticated;
grant select, insert, update on public.automation_cycle_runs to service_role;

create or replace function public.defer_owner_notification_during_rush()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_windows jsonb;
  v_window jsonb;
  v_start time;
  v_end time;
  v_local timestamp;
  v_end_local timestamp;
begin
  if new.severity = 'urgent' then return new; end if;
  select rush_windows into v_windows from public.cafe_settings where id = 1;
  if jsonb_typeof(v_windows) is distinct from 'array' then return new; end if;

  v_local := clock_timestamp() at time zone 'Australia/Sydney';
  for v_window in select value from jsonb_array_elements(v_windows) loop
    if coalesce(v_window->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or coalesce(v_window->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
      continue;
    end if;
    v_start := (v_window->>'start')::time;
    v_end := (v_window->>'end')::time;
    if v_end <= v_start or v_local::time < v_start or v_local::time >= v_end then
      continue;
    end if;
    v_end_local := v_local::date + v_end;
    new.surface_after := greatest(
      coalesce(new.surface_after, clock_timestamp()),
      v_end_local at time zone 'Australia/Sydney'
    );
    exit;
  end loop;
  return new;
end;
$$;

drop trigger if exists defer_owner_notification_during_rush on public.owner_notifications;
create trigger defer_owner_notification_during_rush
before insert or update of severity, surface_after on public.owner_notifications
for each row execute function public.defer_owner_notification_during_rush();

create or replace function public.enqueue_approval_notification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'pending_approval' then
    insert into public.owner_notifications(
      severity, title, body, approval_id, surface_after, channel, status, dedupe_key
    ) values (
      'decision', 'Approval needed', new.summary, new.id, clock_timestamp(),
      'in_app', 'pending', 'approval:' || new.id::text
    ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists enqueue_approval_notification on public.approval_inbox;
create trigger enqueue_approval_notification
after insert on public.approval_inbox
for each row execute function public.enqueue_approval_notification();

insert into public.owner_notifications(
  severity, title, body, approval_id, surface_after, channel, status, dedupe_key
)
select 'decision', 'Approval needed', approval.summary, approval.id, clock_timestamp(),
  'in_app', 'pending', 'approval:' || approval.id::text
from public.approval_inbox approval
where approval.status = 'pending_approval'
on conflict (dedupe_key) where dedupe_key is not null do nothing;

create or replace function public.resolve_owner_approval_notification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'pending_approval' and new.status in ('approved', 'rejected') then
    update public.owner_notifications
    set status = 'done'
    where approval_id = new.id
      and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists resolve_owner_approval_notification on public.approval_inbox;
create trigger resolve_owner_approval_notification
after update of status on public.approval_inbox
for each row execute function public.resolve_owner_approval_notification();

update public.owner_notifications notification
set status = 'done'
from public.approval_inbox approval
where notification.approval_id = approval.id
  and notification.status = 'pending'
  and approval.status in ('approved', 'rejected');

create or replace function public.queue_owner_digest(
  p_digest_date date,
  p_slot text,
  p_event_id uuid,
  p_facts jsonb,
  p_tokens jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_token jsonb;
begin
  if p_digest_date is null or p_slot is null or p_slot not in ('pre_open', 'wrap_up')
    or p_event_id is null or jsonb_typeof(p_facts) is distinct from 'object'
    or jsonb_typeof(p_facts->'items') is distinct from 'array'
    or jsonb_array_length(p_facts->'items') not between 1 and 3
    or jsonb_typeof(p_tokens) is distinct from 'array'
    or jsonb_array_length(p_tokens) not between 2 and 6
    or jsonb_array_length(p_tokens) <> jsonb_array_length(p_facts->'items') * 2 then
    raise exception 'INVALID_OWNER_DIGEST';
  end if;

  insert into public.owner_digest_runs(digest_date, slot, email_event_id)
    values (p_digest_date, p_slot, p_event_id)
    on conflict (digest_date, slot) do nothing
    returning id into v_run_id;
  if v_run_id is null then
    return jsonb_build_object('status', 'already_queued');
  end if;

  for v_token in select value from jsonb_array_elements(p_tokens) loop
    if coalesce(v_token->>'approvalId', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(v_token->>'tokenHash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_token->>'action', '') not in ('approve', 'edit')
      or not exists (
        select 1 from public.approval_inbox approval
        where approval.id = (v_token->>'approvalId')::uuid
          and approval.status = 'pending_approval'
      ) then
      raise exception 'INVALID_OWNER_APPROVAL_TOKEN';
    end if;
    insert into public.approval_tokens(approval_id, token_hash, expires_at, action)
      values (
        (v_token->>'approvalId')::uuid,
        v_token->>'tokenHash',
        clock_timestamp() + interval '24 hours',
        v_token->>'action'
      );
  end loop;

  insert into public.cafe_test_mail(
    event_id, delivery_id, purpose, attempt, facts, payload, channel, status, retry_at, dedupe_key
  ) values (
    p_event_id, null, 'owner_digest', 1, p_facts, null, null, 'queued',
    clock_timestamp(), 'owner-digest:' || p_digest_date::text || ':' || p_slot
  );
  return jsonb_build_object('status', 'queued', 'run_id', v_run_id);
end;
$$;

create or replace function public.get_owner_approval_link(p_token_hash text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'action', token.action,
    'expires_at', token.expires_at,
    'approval_id', approval.id,
    'summary', approval.summary,
    'details', approval.details
  )
  from public.approval_tokens token
  join public.approval_inbox approval on approval.id = token.approval_id
  where token.token_hash = p_token_hash
    and token.used_at is null
    and token.expires_at > clock_timestamp()
    and approval.status = 'pending_approval';
$$;

create or replace function public.consume_owner_approval_token(
  p_token_hash text,
  p_action text,
  p_decision text,
  p_summary text,
  p_details jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token public.approval_tokens%rowtype;
  v_approval public.approval_inbox%rowtype;
begin
  select * into v_token from public.approval_tokens
    where token_hash = p_token_hash for update;
  if not found or v_token.expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_token.used_at is not null then
    return jsonb_build_object('status', 'used');
  end if;
  if v_token.action is distinct from p_action then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_approval from public.approval_inbox
    where id = v_token.approval_id and status = 'pending_approval' for update;
  if not found then
    return jsonb_build_object('status', 'stale');
  end if;

  if p_action = 'approve' then
    if p_decision is null or p_decision not in ('approved', 'rejected') then
      raise exception 'INVALID_OWNER_APPROVAL_DECISION';
    end if;
    update public.approval_inbox
      set status = p_decision,
          reviewer_note = 'Decision made through a single-use owner email link.',
          reviewed_at = clock_timestamp()
      where id = v_approval.id;
    insert into public.agent_activity(tool, input_summary, outcome, reason)
    values (
      'human_approval',
      jsonb_build_object('approval_id', v_approval.id, 'decision', p_decision)::text,
      'success',
      'A human recorded this approval decision from a single-use owner email link.'
    );
  elsif p_action = 'edit' then
    if p_summary is null or length(btrim(p_summary)) not between 1 and 500
      or jsonb_typeof(p_details) is distinct from 'object' then
      raise exception 'INVALID_OWNER_APPROVAL_EDIT';
    end if;
    update public.approval_inbox
      set summary = btrim(p_summary), details = p_details
      where id = v_approval.id;
  else
    raise exception 'INVALID_OWNER_APPROVAL_ACTION';
  end if;

  update public.approval_tokens set used_at = clock_timestamp() where id = v_token.id;
  return jsonb_build_object(
    'status', 'updated',
    'approval_id', v_approval.id,
    'action', v_token.action,
    'decision', p_decision
  );
end;
$$;

revoke all on function public.defer_owner_notification_during_rush() from public, anon, authenticated;
revoke all on function public.enqueue_approval_notification() from public, anon, authenticated;
revoke all on function public.resolve_owner_approval_notification() from public, anon, authenticated;
revoke all on function public.queue_owner_digest(date,text,uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.get_owner_approval_link(text) from public, anon, authenticated;
revoke all on function public.consume_owner_approval_token(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.queue_owner_digest(date,text,uuid,jsonb,jsonb) to service_role;
grant execute on function public.get_owner_approval_link(text) to service_role;
grant execute on function public.consume_owner_approval_token(text,text,text,text,jsonb) to service_role;
grant execute on function public.resolve_owner_approval_notification() to service_role;
grant select, insert, update on public.owner_notifications, public.approval_tokens,
  public.approval_inbox to service_role;

commit;
