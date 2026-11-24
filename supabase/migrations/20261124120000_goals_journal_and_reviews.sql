-- Family Hub: dreams and goals, the journal, and the weekly review.
-- The journal holds wins (however small), learnings (there are no failures),
-- gratitude, things made, health and notes. Nothing is deleted.

-- ---------------------------------------------------------------
-- Dreams and goals
-- ---------------------------------------------------------------
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  why text,
  kind text not null default 'goal' check (kind in ('dream', 'goal', 'milestone')),
  parent_id uuid references public.goals (id) on delete set null,
  measure text,
  target_date date,
  status text not null default 'active' check (status in ('active', 'achieved', 'paused', 'let_go')),
  visibility text not null default 'family' check (visibility in ('family', 'parents', 'private')),
  lead_id uuid not null references public.members (id) on delete cascade,
  created_by uuid references public.members (id) on delete set null,
  door text not null default 'app' check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  achieved_at timestamptz
);
comment on table public.goals is
  'Dreams, goals and milestones. Each has one lead and a team in goal_people. let_go means the family chose to stop; there is no failed status.';
create index goals_lead_idx on public.goals (lead_id);
create index goals_parent_idx on public.goals (parent_id);
create index goals_created_by_idx on public.goals (created_by);

create table public.goal_people (
  goal_id uuid not null references public.goals (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (goal_id, member_id)
);
comment on table public.goal_people is 'The team behind a goal, besides its lead.';
create index goal_people_member_idx on public.goal_people (member_id);

create function private.is_goal_person(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.goal_people gp
    where gp.goal_id = target and gp.member_id = private.current_member_id()
  )
$$;
revoke all on function private.is_goal_person(uuid) from public;
grant execute on function private.is_goal_person(uuid) to authenticated, service_role;

create function private.can_see_goal(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.goals g
    where g.id = target
      and (
        g.lead_id = private.current_member_id()
        or (g.visibility = 'family' and private.current_member_id() is not null)
        or (g.visibility = 'parents' and private.current_member_role() = 'parent')
        or (private.current_member_role() = 'parent' and private.member_role(g.lead_id) = 'child')
        or private.is_goal_person(g.id)
      )
  )
$$;
revoke all on function private.can_see_goal(uuid) from public;
grant execute on function private.can_see_goal(uuid) to authenticated, service_role;

create function private.can_edit_goal(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.goals g
    where g.id = target
      and (
        g.lead_id = private.current_member_id()
        or (private.current_member_role() = 'parent' and private.member_role(g.lead_id) = 'child')
        or private.is_goal_person(g.id)
      )
  )
$$;
revoke all on function private.can_edit_goal(uuid) from public;
grant execute on function private.can_edit_goal(uuid) to authenticated, service_role;

create function private.goals_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.door := private.current_door();
    new.created_by := coalesce(private.current_member_id(), new.created_by);
    new.created_at := now();
    new.achieved_at := case when new.status = 'achieved' then now() else null end;
  else
    new.lead_id := old.lead_id;
    new.created_by := old.created_by;
    new.door := old.door;
    new.created_at := old.created_at;
    if new.status is distinct from old.status then
      new.achieved_at := case when new.status = 'achieved' then now() else null end;
    else
      new.achieved_at := old.achieved_at;
    end if;
  end if;
  if new.visibility = 'private' and private.member_role(new.lead_id) = 'child' then
    raise exception 'A child''s goal cannot be private. Use parents or family.'
      using errcode = 'check_violation';
  end if;
  if new.parent_id = new.id then
    new.parent_id := null;
  end if;
  new.title := btrim(new.title);
  new.updated_at := now();
  return new;
end
$$;
revoke all on function private.goals_rules() from public;
grant execute on function private.goals_rules() to authenticated, service_role;

create trigger goals_rules
  before insert or update on public.goals
  for each row execute function private.goals_rules();

alter table public.goals enable row level security;
alter table public.goal_people enable row level security;
revoke all on table public.goals from anon, authenticated;
revoke all on table public.goal_people from anon, authenticated;
grant select on table public.goals to authenticated;
grant insert (title, why, kind, parent_id, measure, target_date, status, visibility, lead_id, created_by)
  on table public.goals to authenticated;
grant update (title, why, kind, parent_id, measure, target_date, status, visibility)
  on table public.goals to authenticated;
grant select on table public.goal_people to authenticated;
grant insert (goal_id, member_id) on table public.goal_people to authenticated;

create policy "see goals shared with you"
  on public.goals for select to authenticated
  using (
    lead_id = (select private.current_member_id())
    or (visibility = 'family' and (select private.current_member_id()) is not null)
    or (visibility = 'parents' and (select private.current_member_role()) = 'parent')
    or ((select private.current_member_role()) = 'parent' and private.member_role(lead_id) = 'child')
    or private.is_goal_person(id)
  );

create policy "set a goal you lead, or a parent sets one for a child"
  on public.goals for insert to authenticated
  with check (
    created_by = (select private.current_member_id())
    and (
      lead_id = (select private.current_member_id())
      or ((select private.current_member_role()) = 'parent' and private.member_role(lead_id) = 'child')
    )
  );

create policy "the lead, the team, or a child's parent updates a goal"
  on public.goals for update to authenticated
  using (
    lead_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(lead_id) = 'child')
    or private.is_goal_person(id)
  )
  with check (
    lead_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(lead_id) = 'child')
    or private.is_goal_person(id)
  );

create policy "see the team on goals you can see"
  on public.goal_people for select to authenticated
  using (private.can_see_goal(goal_id));

create policy "the lead or the team adds people to a goal"
  on public.goal_people for insert to authenticated
  with check (private.can_edit_goal(goal_id));

-- ---------------------------------------------------------------
-- The journal
-- ---------------------------------------------------------------
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  kind text not null check (kind in ('win', 'learning', 'gratitude', 'made', 'health', 'note')),
  body text not null check (length(btrim(body)) between 1 and 2000),
  goal_id uuid references public.goals (id) on delete set null,
  thanks_to uuid references public.members (id) on delete set null,
  tool text,
  happened_on date not null default ((now() at time zone 'Australia/Sydney')::date),
  visibility text not null check (visibility in ('family', 'parents', 'private')),
  door text not null default 'app' check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  added_by uuid references public.members (id) on delete set null,
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
comment on table public.entries is
  'The journal: what happened, in the person''s words. win = any win, however small; learning = what something taught us (never a failure); gratitude; made = something built or created; health = a health issue experienced; note. Entries are not edited; a mistake is withdrawn.';
comment on column public.entries.visibility is
  'Left empty, it becomes parents for health and family for everything else.';
create index entries_day_idx on public.entries (happened_on);
create index entries_member_idx on public.entries (member_id, happened_on);
create index entries_goal_idx on public.entries (goal_id);
create index entries_thanks_to_idx on public.entries (thanks_to);
create index entries_added_by_idx on public.entries (added_by);

create function private.entries_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.door := private.current_door();
    new.created_at := now();
    new.withdrawn_at := null;
    if new.visibility is null then
      new.visibility := case when new.kind = 'health' then 'parents' else 'family' end;
    end if;
    if new.visibility = 'private' and private.member_role(new.member_id) = 'child' then
      raise exception 'A child''s journal has no private entries. Use parents or family.'
        using errcode = 'check_violation';
    end if;
    new.body := btrim(new.body);
  else
    -- what happened is never rewritten; an entry can only be withdrawn
    new.member_id := old.member_id;
    new.kind := old.kind;
    new.body := old.body;
    new.goal_id := old.goal_id;
    new.thanks_to := old.thanks_to;
    new.tool := old.tool;
    new.happened_on := old.happened_on;
    new.visibility := old.visibility;
    new.door := old.door;
    new.added_by := old.added_by;
    new.created_at := old.created_at;
  end if;
  return new;
end
$$;
revoke all on function private.entries_rules() from public;
grant execute on function private.entries_rules() to authenticated, service_role;

create trigger entries_rules
  before insert or update on public.entries
  for each row execute function private.entries_rules();

alter table public.entries enable row level security;
revoke all on table public.entries from anon, authenticated;
grant select on table public.entries to authenticated;
grant insert (member_id, kind, body, goal_id, thanks_to, tool, happened_on, visibility, added_by)
  on table public.entries to authenticated;
grant update (withdrawn_at) on table public.entries to authenticated;

create policy "read the journal by ownership and visibility"
  on public.entries for select to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    or (
      withdrawn_at is null
      and (
        (visibility = 'family' and (select private.current_member_id()) is not null)
        or (visibility = 'parents' and (select private.current_member_role()) = 'parent')
      )
    )
  );

create policy "write in your own journal, a parent writes in a child's"
  on public.entries for insert to authenticated
  with check (
    added_by = (select private.current_member_id())
    and (
      member_id = (select private.current_member_id())
      or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    )
    and (goal_id is null or private.can_see_goal(goal_id))
  );

create policy "withdraw your own entry, a parent withdraws a child's"
  on public.entries for update to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  )
  with check (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  );

-- ---------------------------------------------------------------
-- Weekly reviews
-- ---------------------------------------------------------------
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  week_start date not null check (extract(isodow from week_start) = 1),
  member_id uuid not null references public.members (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 6000),
  ai_skill text,
  next_try text,
  visibility text not null default 'family' check (visibility in ('family', 'parents', 'private')),
  door text not null default 'app' check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  added_by uuid references public.members (id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);
comment on table public.reviews is
  'One review per person per week (weeks start on Monday). Running it again keeps the earlier version as superseded.';
create unique index reviews_current_idx on public.reviews (member_id, week_start) where superseded_at is null;
create index reviews_week_idx on public.reviews (week_start);
create index reviews_added_by_idx on public.reviews (added_by);

create function private.reviews_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.door := private.current_door();
    new.created_at := now();
    new.superseded_at := null;
    if new.visibility = 'private' and private.member_role(new.member_id) = 'child' then
      raise exception 'A child''s review cannot be private. Use parents or family.'
        using errcode = 'check_violation';
    end if;
  else
    new.week_start := old.week_start;
    new.member_id := old.member_id;
    new.body := old.body;
    new.ai_skill := old.ai_skill;
    new.next_try := old.next_try;
    new.visibility := old.visibility;
    new.door := old.door;
    new.added_by := old.added_by;
    new.created_at := old.created_at;
  end if;
  return new;
end
$$;
revoke all on function private.reviews_rules() from public;
grant execute on function private.reviews_rules() to authenticated, service_role;

create trigger reviews_rules
  before insert or update on public.reviews
  for each row execute function private.reviews_rules();

alter table public.reviews enable row level security;
revoke all on table public.reviews from anon, authenticated;
grant select on table public.reviews to authenticated;
grant insert (week_start, member_id, body, ai_skill, next_try, visibility, added_by)
  on table public.reviews to authenticated;
grant update (superseded_at) on table public.reviews to authenticated;

create policy "read reviews by ownership and visibility"
  on public.reviews for select to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    or (
      superseded_at is null
      and (
        (visibility = 'family' and (select private.current_member_id()) is not null)
        or (visibility = 'parents' and (select private.current_member_role()) = 'parent')
      )
    )
  );

create policy "save your own review, a parent saves a child's"
  on public.reviews for insert to authenticated
  with check (
    added_by = (select private.current_member_id())
    and (
      member_id = (select private.current_member_id())
      or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
    )
  );

create policy "replace your own review, a parent replaces a child's"
  on public.reviews for update to authenticated
  using (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  )
  with check (
    member_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent' and private.member_role(member_id) = 'child')
  );

-- ---------------------------------------------------------------
-- Every new table: an AI token works only while it is switched on
-- ---------------------------------------------------------------
create policy "an AI reaches the hub only while switched on"
  on public.goals as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.goal_people as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.entries as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.reviews as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
