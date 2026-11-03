-- Run manually in the Supabase SQL Editor after the existing agent and ordering
-- setup scripts. This file is not applied automatically.
begin;

create table if not exists public.daily_briefs (
  brief_date date primary key,
  greeting text not null check (length(trim(greeting)) between 1 and 160),
  status_line text not null check (length(trim(status_line)) between 1 and 240),
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 3),
  all_clear text not null check (length(trim(all_clear)) between 1 and 500),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  generated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.public_holidays (
  jurisdiction text not null default 'NSW'
    check (jurisdiction in ('NSW')),
  holiday_date date not null,
  name text not null check (length(trim(name)) between 1 and 120),
  source text not null default 'NSW Government',
  primary key (jurisdiction, holiday_date)
);

create table if not exists public.agent_threads (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New conversation'
    check (length(trim(title)) between 1 and 160),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  role text not null check (role in ('owner', 'agent')),
  content text not null default '' check (length(content) <= 12000),
  parts jsonb not null default '[]'::jsonb check (jsonb_typeof(parts) = 'array'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.standing_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  enabled boolean not null default true,
  ingredient_ids text[] not null default '{}',
  supplier text,
  maximum_total numeric check (maximum_total is null or maximum_total >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.agent_memory (
  id uuid primary key default gen_random_uuid(),
  memory_key text not null unique check (length(trim(memory_key)) between 1 and 160),
  memory_value jsonb not null check (jsonb_typeof(memory_value) = 'object'),
  occurrences integer not null default 1 check (occurrences > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists daily_briefs_generated_at_idx
  on public.daily_briefs (generated_at desc);
create index if not exists agent_threads_updated_at_idx
  on public.agent_threads (updated_at desc);
create index if not exists agent_messages_thread_created_at_idx
  on public.agent_messages (thread_id, created_at);
create index if not exists standing_rules_enabled_idx
  on public.standing_rules (enabled) where enabled;

alter table public.daily_briefs enable row level security;
alter table public.public_holidays enable row level security;
alter table public.agent_threads enable row level security;
alter table public.agent_messages enable row level security;
alter table public.standing_rules enable row level security;
alter table public.agent_memory enable row level security;

revoke all on table public.daily_briefs from public, anon, authenticated;
revoke all on table public.public_holidays from public, anon, authenticated;
revoke all on table public.agent_threads from public, anon, authenticated;
revoke all on table public.agent_messages from public, anon, authenticated;
revoke all on table public.standing_rules from public, anon, authenticated;
revoke all on table public.agent_memory from public, anon, authenticated;

grant select, insert, update on table public.daily_briefs to service_role;
grant select on table public.public_holidays to service_role;
grant select, insert, update on table public.agent_threads to service_role;
grant select, insert on table public.agent_messages to service_role;
grant select, insert, update on table public.standing_rules to service_role;
grant select, insert, update on table public.agent_memory to service_role;

create or replace function public.record_human_approval_decision(
  p_approval_id uuid,
  p_decision text,
  p_reviewer_note text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_decision is null or p_decision not in ('approved', 'rejected')
    or p_reviewer_note is null or length(p_reviewer_note) > 500 then
    raise exception 'INVALID_APPROVAL_DECISION';
  end if;

  update public.approval_inbox
    set status = p_decision,
        reviewer_note = p_reviewer_note,
        reviewed_at = clock_timestamp()
    where id = p_approval_id and status = 'pending_approval';
  if not found then return false; end if;

  insert into public.agent_activity (tool, input_summary, outcome, reason)
    values (
      'human_approval',
      jsonb_build_object('approval_id', p_approval_id, 'decision', p_decision)::text,
      'success',
      'A human recorded this approval decision. No order was placed or sent.'
    );
  return true;
end;
$$;

revoke all on function public.record_human_approval_decision(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.record_human_approval_decision(uuid,text,text)
  to service_role;

-- NSW's official 2026 holidays. Avoid seeding a made-up current-week holiday.
-- Source: https://www.nsw.gov.au/about-nsw/public-holidays
insert into public.public_holidays (jurisdiction, holiday_date, name)
values
  ('NSW', '2026-01-01', 'New Year''s Day'),
  ('NSW', '2026-01-26', 'Australia Day'),
  ('NSW', '2026-04-03', 'Good Friday'),
  ('NSW', '2026-04-04', 'Easter Saturday'),
  ('NSW', '2026-04-05', 'Easter Sunday'),
  ('NSW', '2026-04-06', 'Easter Monday'),
  ('NSW', '2026-04-25', 'Anzac Day'),
  ('NSW', '2026-04-27', 'Additional public holiday'),
  ('NSW', '2026-06-08', 'King''s Birthday'),
  ('NSW', '2026-10-05', 'Labour Day'),
  ('NSW', '2026-12-25', 'Christmas Day'),
  ('NSW', '2026-12-26', 'Boxing Day'),
  ('NSW', '2026-12-28', 'Additional public holiday')
on conflict (jurisdiction, holiday_date) do nothing;

commit;
