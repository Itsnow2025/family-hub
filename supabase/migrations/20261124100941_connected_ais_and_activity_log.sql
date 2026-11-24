-- Family Hub, stage 1: connected AIs, the AI off switches, the activity log,
-- and door stamping. An AI reaches the hub with an OAuth token that carries
-- the client_id of the AI app; the rules below key off that claim.

-- ---------------------------------------------------------------
-- Helpers about the current request
-- ---------------------------------------------------------------
create function private.current_client_id() returns text
language sql stable set search_path = ''
as $$ select nullif((select auth.jwt()) ->> 'client_id', '') $$;
revoke all on function private.current_client_id() from public;
grant execute on function private.current_client_id() to authenticated, service_role;

-- ---------------------------------------------------------------
-- Family switch: a parent can turn off every AI for a child at once
-- ---------------------------------------------------------------
alter table public.members
  add column ai_access boolean not null default true;
comment on column public.members.ai_access is
  'false = no AI can reach the hub as this person, whatever they have connected. Parents control it for themselves and for a child.';

-- ---------------------------------------------------------------
-- Connected AIs: one row per AI app a person has approved
-- ---------------------------------------------------------------
create table public.connected_ais (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  client_id text not null,
  client_name text not null,
  door text not null check (door in ('grok', 'claude', 'other_ai')),
  enabled boolean not null default true,
  changed_by uuid references public.members (id) on delete set null,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, client_id)
);
comment on table public.connected_ais is
  'AI apps a member approved on the consent page. Switching one off blocks its tokens in every table rule.';
create index connected_ais_client_idx on public.connected_ais (client_id);
create index connected_ais_changed_by_idx on public.connected_ais (changed_by);

-- Is the current request allowed? Direct app sessions always are; an AI
-- token only while the person's AI access is on and that AI is switched on.
create function private.ai_allowed() returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.current_client_id() is null
      or exists (
        select 1
        from public.members m
        join public.connected_ais c on c.member_id = m.id
        where m.user_id = (select auth.uid())
          and m.ai_access
          and c.enabled
          and c.client_id = private.current_client_id()
      )
$$;
revoke all on function private.ai_allowed() from public;
grant execute on function private.ai_allowed() to authenticated, service_role;

-- Which door is this request coming through?
create function private.current_door() returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when private.current_client_id() is null then 'app'
    else coalesce((
      select c.door
      from public.connected_ais c
      join public.members m on m.id = c.member_id
      where m.user_id = (select auth.uid())
        and c.client_id = private.current_client_id()
    ), 'other_ai')
  end
$$;
revoke all on function private.current_door() from public;
grant execute on function private.current_door() to authenticated, service_role;

create function private.connected_ais_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := private.current_member_id();
begin
  if tg_op = 'UPDATE' then
    new.member_id := old.member_id;
    new.client_id := old.client_id;
    new.approved_at := old.approved_at;
    -- a child cannot switch back on an AI that a parent switched off
    if new.enabled and not old.enabled
       and private.current_member_role() = 'child'
       and old.changed_by is not null
       and private.member_role(old.changed_by) = 'parent' then
      raise exception 'A parent switched this AI off. Ask a parent to switch it back on.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  new.changed_by := me;
  new.updated_at := now();
  return new;
end
$$;
revoke all on function private.connected_ais_rules() from public;
grant execute on function private.connected_ais_rules() to authenticated, service_role;

create trigger connected_ais_rules
  before insert or update on public.connected_ais
  for each row execute function private.connected_ais_rules();

alter table public.connected_ais enable row level security;
revoke all on table public.connected_ais from anon, authenticated;
grant select on table public.connected_ais to authenticated;
grant insert (member_id, client_id, client_name, door) on table public.connected_ais to authenticated;
grant update (enabled, client_name, door) on table public.connected_ais to authenticated;

create policy "see your own connected AIs; parents see all"
  on public.connected_ais for select to authenticated
  using (
    member_id = (select private.current_member_id())
    or (select private.current_member_role()) = 'parent'
  );

create policy "connect an AI for yourself, from the app only"
  on public.connected_ais for insert to authenticated
  with check (
    member_id = (select private.current_member_id())
    and (select private.current_client_id()) is null
  );

create policy "switch your own AI; parents switch any, from the app only"
  on public.connected_ais for update to authenticated
  using (
    (select private.current_client_id()) is null
    and (
      member_id = (select private.current_member_id())
      or (select private.current_member_role()) = 'parent'
    )
  )
  with check (
    (select private.current_client_id()) is null
    and (
      member_id = (select private.current_member_id())
      or (select private.current_member_role()) = 'parent'
    )
  );

-- Parents flip the family switch for themselves and for a child, from the app only.
grant update (ai_access) on table public.members to authenticated;
create policy "parents set AI access for themselves and a child, from the app only"
  on public.members for update to authenticated
  using (
    (select private.current_client_id()) is null
    and (select private.current_member_role()) = 'parent'
    and (id = (select private.current_member_id()) or role = 'child')
  )
  with check (
    (select private.current_client_id()) is null
    and (select private.current_member_role()) = 'parent'
    and (id = (select private.current_member_id()) or role = 'child')
  );

-- ---------------------------------------------------------------
-- Activity log
-- ---------------------------------------------------------------
create table public.activity_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.members (id) on delete set null,
  subject_id uuid references public.members (id) on delete set null,
  door text not null check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  client_id text,
  action text not null check (length(btrim(action)) > 0),
  target_id uuid,
  summary text,
  created_at timestamptz not null default now()
);
comment on table public.activity_log is
  'Who did what, through which door. Writes to files are logged by triggers; reads by AI are logged by the connector. Nothing is changed or deleted.';
create index activity_log_actor_idx on public.activity_log (actor_id, created_at desc);
create index activity_log_subject_idx on public.activity_log (subject_id, created_at desc);

create function private.activity_log_stamp() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.actor_id := private.current_member_id();
  if new.actor_id is null then
    raise exception 'Only a member can write to the activity log.'
      using errcode = 'insufficient_privilege';
  end if;
  new.door := private.current_door();
  new.client_id := private.current_client_id();
  new.created_at := now();
  return new;
end
$$;
revoke all on function private.activity_log_stamp() from public;
grant execute on function private.activity_log_stamp() to authenticated, service_role;

create trigger activity_log_stamp
  before insert on public.activity_log
  for each row execute function private.activity_log_stamp();

alter table public.activity_log enable row level security;
revoke all on table public.activity_log from anon, authenticated;
grant select on table public.activity_log to authenticated;
grant insert (subject_id, action, target_id, summary) on table public.activity_log to authenticated;

create policy "see what you did or what touched your file; parents see all"
  on public.activity_log for select to authenticated
  using (
    actor_id = (select private.current_member_id())
    or subject_id = (select private.current_member_id())
    or (select private.current_member_role()) = 'parent'
  );

create policy "log your own actions"
  on public.activity_log for insert to authenticated
  with check (actor_id = (select private.current_member_id()));

-- Writes to files log themselves, whatever door they come through.
create function private.log_preference_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  act text;
begin
  if tg_op = 'INSERT' then
    act := case new.status when 'suggested' then 'preference.suggested' else 'preference.added' end;
  elsif new.status is distinct from old.status then
    act := 'preference.' || new.status;
  else
    act := 'preference.changed';
  end if;
  insert into public.activity_log (subject_id, action, target_id, summary)
  values (new.member_id, act, new.id, left(new.category || ': ' || new.statement, 240));
  return null;
end
$$;
revoke all on function private.log_preference_change() from public;

create trigger preferences_log
  after insert or update on public.preferences
  for each row execute function private.log_preference_change();

create function private.log_about_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.about is distinct from old.about then
    insert into public.activity_log (subject_id, action, target_id, summary)
    values (new.member_id, 'file.about_changed', new.id, left(coalesce(new.about, ''), 240));
  end if;
  return null;
end
$$;
revoke all on function private.log_about_change() from public;

create trigger personal_files_log
  after update on public.personal_files
  for each row execute function private.log_about_change();

-- ---------------------------------------------------------------
-- Door stamping on preferences: the database decides the door
-- ---------------------------------------------------------------
create or replace function private.preferences_rules() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- an entry never moves to another file, changes its author or its door
    new.member_id := old.member_id;
    new.added_by := old.added_by;
    new.created_at := old.created_at;
    new.door := old.door;
  else
    new.door := private.current_door();
  end if;

  if new.visibility = 'private' and private.member_role(new.member_id) = 'child' then
    raise exception 'A child''s file has no private entries. Use parents or family.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    new.confirmed_at := now();
  end if;
  if new.status = 'retired' and (tg_op = 'INSERT' or old.status is distinct from 'retired') then
    new.retired_at := now();
  end if;

  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------
-- Every table: an AI token works only while it is switched on
-- ---------------------------------------------------------------
create policy "an AI reaches the hub only while switched on"
  on public.members as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.personal_files as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.preferences as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.connected_ais as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.activity_log as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));

-- ---------------------------------------------------------------
-- Status check the connector can call even when access is off,
-- so it can tell the person why instead of failing silently.
-- ---------------------------------------------------------------
create function public.hub_connection_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when m.id is null then jsonb_build_object('status', 'not_a_member')
    when private.current_client_id() is null then
      jsonb_build_object('status', 'app_session', 'member_id', m.id, 'name', m.display_name, 'role', m.role)
    when not m.ai_access then
      jsonb_build_object('status', 'ai_access_off', 'member_id', m.id, 'name', m.display_name, 'role', m.role)
    when c.id is null then
      jsonb_build_object('status', 'not_connected', 'member_id', m.id, 'name', m.display_name, 'role', m.role)
    when not c.enabled then
      jsonb_build_object('status', 'switched_off', 'member_id', m.id, 'name', m.display_name, 'role', m.role,
                         'client_name', c.client_name)
    else
      jsonb_build_object('status', 'ok', 'member_id', m.id, 'name', m.display_name, 'role', m.role,
                         'door', c.door, 'client_name', c.client_name)
  end
  from (select 1) as one
  left join public.members m on m.user_id = (select auth.uid())
  left join public.connected_ais c
    on c.member_id = m.id and c.client_id = private.current_client_id()
$$;
revoke all on function public.hub_connection_status() from public, anon;
grant execute on function public.hub_connection_status() to authenticated;
comment on function public.hub_connection_status() is
  'Who is calling and whether their AI may act. Reveals only the caller''s own status.';
