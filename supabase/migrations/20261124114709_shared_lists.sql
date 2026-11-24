-- Family Hub: shared lists. Shopping first; any member can start another.
-- Anyone who can see a list can add to it and tick things off.
-- Nothing is deleted: an item is marked got or removed.

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  visibility text not null default 'family'
    check (visibility in ('family', 'parents', 'private')),
  owner_id uuid not null references public.members (id) on delete cascade,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
comment on table public.lists is
  'Shared lists such as Shopping. family = all three; parents = owner and both parents; private = owner only (not for a child''s list).';
create index lists_owner_idx on public.lists (owner_id);

create table public.list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  item text not null check (length(btrim(item)) between 1 and 200),
  note text,
  status text not null default 'needed'
    check (status in ('needed', 'got', 'removed')),
  added_by uuid references public.members (id) on delete set null,
  door text not null default 'app'
    check (door in ('app', 'grok', 'claude', 'other_ai', 'system')),
  added_at timestamptz not null default now(),
  done_by uuid references public.members (id) on delete set null,
  done_at timestamptz
);
comment on table public.list_items is
  'One row per thing on a list. needed = still to get; got = ticked off; removed = taken off without getting it.';
create index list_items_list_idx on public.list_items (list_id, status);
create index list_items_added_by_idx on public.list_items (added_by);
create index list_items_done_by_idx on public.list_items (done_by);

-- Can the person asking see this list?
create function private.can_see_list(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.lists l
    where l.id = target
      and (
        l.owner_id = private.current_member_id()
        or (l.visibility = 'family' and private.current_member_id() is not null)
        or (l.visibility = 'parents' and private.current_member_role() = 'parent')
        or (private.current_member_role() = 'parent' and private.member_role(l.owner_id) = 'child')
      )
  )
$$;
revoke all on function private.can_see_list(uuid) from public;
grant execute on function private.can_see_list(uuid) to authenticated, service_role;

create function private.lists_rules() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
  end if;
  if new.visibility = 'private' and private.member_role(new.owner_id) = 'child' then
    raise exception 'A child''s list cannot be private. Use parents or family.'
      using errcode = 'check_violation';
  end if;
  new.name := btrim(new.name);
  return new;
end
$$;
revoke all on function private.lists_rules() from public;
grant execute on function private.lists_rules() to authenticated, service_role;

create trigger lists_rules
  before insert or update on public.lists
  for each row execute function private.lists_rules();

create function private.list_items_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.door := private.current_door();
    new.added_at := now();
    new.done_by := null;
    new.done_at := null;
    new.status := 'needed';
  else
    -- an item never moves list or changes who added it
    new.list_id := old.list_id;
    new.added_by := old.added_by;
    new.door := old.door;
    new.added_at := old.added_at;
    if new.status is distinct from old.status then
      if new.status = 'needed' then
        new.done_by := null;
        new.done_at := null;
      else
        new.done_by := private.current_member_id();
        new.done_at := now();
      end if;
    else
      new.done_by := old.done_by;
      new.done_at := old.done_at;
    end if;
  end if;
  new.item := btrim(new.item);
  return new;
end
$$;
revoke all on function private.list_items_rules() from public;
grant execute on function private.list_items_rules() to authenticated, service_role;

create trigger list_items_rules
  before insert or update on public.list_items
  for each row execute function private.list_items_rules();

alter table public.lists enable row level security;
alter table public.list_items enable row level security;
revoke all on table public.lists from anon, authenticated;
revoke all on table public.list_items from anon, authenticated;

grant select on table public.lists to authenticated;
grant insert (name, visibility, owner_id) on table public.lists to authenticated;
grant update (name, visibility, archived_at) on table public.lists to authenticated;
grant select on table public.list_items to authenticated;
grant insert (list_id, item, note, added_by) on table public.list_items to authenticated;
grant update (status, item, note) on table public.list_items to authenticated;

create policy "see lists shared with you"
  on public.lists for select to authenticated
  using (
    owner_id = (select private.current_member_id())
    or (visibility = 'family' and (select private.current_member_id()) is not null)
    or (visibility = 'parents' and (select private.current_member_role()) = 'parent')
    or ((select private.current_member_role()) = 'parent' and private.member_role(owner_id) = 'child')
  );

create policy "start a list of your own"
  on public.lists for insert to authenticated
  with check (owner_id = (select private.current_member_id()));

create policy "the owner or a parent renames or archives a list"
  on public.lists for update to authenticated
  using (
    owner_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent'
        and (visibility <> 'private' or private.member_role(owner_id) = 'child'))
  )
  with check (
    owner_id = (select private.current_member_id())
    or ((select private.current_member_role()) = 'parent'
        and (visibility <> 'private' or private.member_role(owner_id) = 'child'))
  );

create policy "see items on lists you can see"
  on public.list_items for select to authenticated
  using (private.can_see_list(list_id));

create policy "add to any list you can see"
  on public.list_items for insert to authenticated
  with check (
    private.can_see_list(list_id)
    and added_by = (select private.current_member_id())
  );

create policy "tick off or change items on lists you can see"
  on public.list_items for update to authenticated
  using (private.can_see_list(list_id))
  with check (private.can_see_list(list_id));

create policy "an AI reaches the hub only while switched on"
  on public.lists as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));
create policy "an AI reaches the hub only while switched on"
  on public.list_items as restrictive for all to authenticated
  using ((select private.ai_allowed())) with check ((select private.ai_allowed()));

-- The family shopping list, ready to use.
insert into public.lists (name, visibility, owner_id)
select 'Shopping', 'family', id from public.members where email = 'feriqueb@gmail.com';

-- Phil's connected AI introduces itself as "Cursor"; it is his Grok Bot.
update public.connected_ais
   set client_name = 'Grok Bot', door = 'grok'
 where client_name = 'Cursor';
