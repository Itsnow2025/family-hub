-- Family Hub: the three members, a personal file for each, and the
-- preferences that build up inside each file.
-- Every table is locked by row level security; nothing is readable
-- without signing in as one of the three members.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------
create table public.members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  email text not null unique check (email = lower(email)),
  display_name text not null,
  role text not null check (role in ('parent', 'child')),
  created_at timestamptz not null default now()
);
comment on table public.members is
  'The people of Family Hub. Rows are added by migration only; nobody can join through the app or an AI.';

-- ---------------------------------------------------------------
-- Personal files: one per member
-- ---------------------------------------------------------------
create table public.personal_files (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null unique references public.members (id) on delete cascade,
  about text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.personal_files is
  'One file per member. The about text is a short description the owner writes; preferences hang off the file.';

-- ---------------------------------------------------------------
-- Preferences: the library that builds up in each file
-- ---------------------------------------------------------------
create table public.preferences (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  category text not null check (length(btrim(category)) > 0),
  statement text not null check (length(btrim(statement)) > 0),
  detail text,
  visibility text not null default 'family'
    check (visibility in ('private', 'parents', 'family')),
  status text not null default 'confirmed'
    check (status in ('suggested', 'confirmed', 'retired')),
  source text not null default 'self'
    check (source in ('self', 'parent', 'ai_suggested', 'imported')),
  door text not null default 'app'
    check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  added_by uuid references public.members (id) on delete set null,
  replaces uuid references public.preferences (id) on delete set null,
  confirmed_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.preferences is
  'One row per preference in a member''s file. Nothing is deleted: an entry is retired, or replaced by a newer one.';
comment on column public.preferences.visibility is
  'private = owner only (not available in a child''s file); parents = owner and both parents; family = all three.';
comment on column public.preferences.status is
  'suggested = an AI noticed it and the owner has not confirmed; confirmed = in force; retired = no longer true.';
comment on column public.preferences.door is
  'How the entry arrived: the app, a named AI, or the system.';

create index preferences_member_idx on public.preferences (member_id, status, category);
create index preferences_added_by_idx on public.preferences (added_by);
create index preferences_replaces_idx on public.preferences (replaces);

-- ---------------------------------------------------------------
-- Who is asking: helpers used by the access rules
-- ---------------------------------------------------------------
create function private.current_member_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select m.id from public.members m where m.user_id = (select auth.uid()) $$;

create function private.current_member_role() returns text
language sql stable security definer set search_path = ''
as $$ select m.role from public.members m where m.user_id = (select auth.uid()) $$;

create function private.member_role(target uuid) returns text
language sql stable security definer set search_path = ''
as $$ select m.role from public.members m where m.id = target $$;

revoke all on function private.current_member_id() from public;
revoke all on function private.current_member_role() from public;
revoke all on function private.member_role(uuid) from public;
grant execute on function private.current_member_id() to authenticated, service_role;
grant execute on function private.current_member_role() to authenticated, service_role;
grant execute on function private.member_role(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Rules that hold whatever door an entry comes through
-- ---------------------------------------------------------------
create function private.preferences_rules() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- an entry never moves to another file or changes its author
    new.member_id := old.member_id;
    new.added_by := old.added_by;
    new.created_at := old.created_at;
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
revoke all on function private.preferences_rules() from public;
grant execute on function private.preferences_rules() to authenticated, service_role;

create trigger preferences_rules
  before insert or update on public.preferences
  for each row execute function private.preferences_rules();

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
revoke all on function private.touch_updated_at() from public;
grant execute on function private.touch_updated_at() to authenticated, service_role;

create trigger personal_files_touch
  before update on public.personal_files
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------
alter table public.members enable row level security;
alter table public.personal_files enable row level security;
alter table public.preferences enable row level security;

revoke all on table public.members from anon, authenticated;
revoke all on table public.personal_files from anon, authenticated;
revoke all on table public.preferences from anon, authenticated;

grant select on table public.members to authenticated;
grant select on table public.personal_files to authenticated;
grant update (about) on table public.personal_files to authenticated;
grant select, insert, update on table public.preferences to authenticated;

create policy "members see the member list"
  on public.members for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "members see every personal file"
  on public.personal_files for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "owner edits own about text, a parent edits a child's"
  on public.personal_files for update to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  )
  with check (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  );

create policy "read preferences by ownership and visibility"
  on public.preferences for select to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    or (status = 'confirmed' and visibility = 'family' and (select private.current_member_id()) is not null)
    or (status = 'confirmed' and visibility = 'parents' and (select private.current_member_role()) = 'parent')
  );

create policy "add to your own file, a parent adds to a child's"
  on public.preferences for insert to authenticated
  with check (
    added_by = (select private.current_member_id())
    and (
      member_id = (select private.current_member_id())
      or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    )
  );

create policy "change your own file, a parent changes a child's"
  on public.preferences for update to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  )
  with check (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  );

-- ---------------------------------------------------------------
-- Only the three members can ever hold a sign-in
-- ---------------------------------------------------------------
create function private.block_unknown_signups() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null
     or not exists (select 1 from public.members m where m.email = lower(new.email)) then
    raise exception 'This email address is not a member of Family Hub.';
  end if;
  return new;
end
$$;
revoke all on function private.block_unknown_signups() from public;

create trigger family_hub_allowlist
  before insert on auth.users
  for each row execute function private.block_unknown_signups();

create function private.link_member_to_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.members
     set user_id = new.id
   where email = lower(new.email) and user_id is null;
  return new;
end
$$;
revoke all on function private.link_member_to_user() from public;

create trigger family_hub_link_member
  after insert on auth.users
  for each row execute function private.link_member_to_user();

-- ---------------------------------------------------------------
-- The three members and their empty files
-- ---------------------------------------------------------------
insert into public.members (email, display_name, role) values
  ('phil@kula.digital', 'Phil', 'parent'),
  ('feriqueb@gmail.com', 'Ferique', 'parent'),
  ('gigi@goldengladeranch.com', 'Gigi', 'child');

insert into public.personal_files (member_id)
select id from public.members;
