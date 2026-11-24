import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConnectionStatus,
  Door,
  HubData,
  HubList,
  ItemStatus,
  ListItem,
  Member,
  NewPreference,
  PersonalFile,
  Preference,
  PreferenceStatus,
  Role,
} from "./types";

const PREFERENCE_COLUMNS =
  "id, member_id, category, statement, detail, visibility, status, source, door, added_by, created_at";

interface PreferenceRow {
  id: string;
  member_id: string;
  category: string;
  statement: string;
  detail: string | null;
  visibility: Preference["visibility"];
  status: PreferenceStatus;
  source: Preference["source"];
  door: Door;
  added_by: string | null;
  created_at: string;
}

function toPreference(row: PreferenceRow, names: Map<string, string>): Preference {
  return {
    id: row.id,
    memberId: row.member_id,
    category: row.category,
    statement: row.statement,
    detail: row.detail,
    visibility: row.visibility,
    status: row.status,
    source: row.source,
    door: row.door,
    addedBy: row.added_by ? (names.get(row.added_by) ?? null) : null,
    createdAt: row.created_at,
  };
}

const ITEM_COLUMNS = "id, list_id, item, note, status, added_by, door, added_at, done_by, done_at";

interface ItemRow {
  id: string;
  list_id: string;
  item: string;
  note: string | null;
  status: ItemStatus;
  added_by: string | null;
  door: Door;
  added_at: string;
  done_by: string | null;
  done_at: string | null;
}

function toItem(row: ItemRow, names: Map<string, string>): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    item: row.item,
    note: row.note,
    status: row.status,
    addedBy: row.added_by ? (names.get(row.added_by) ?? null) : null,
    door: row.door,
    addedAt: row.added_at,
    doneBy: row.done_by ? (names.get(row.done_by) ?? null) : null,
    doneAt: row.done_at,
  };
}

// Things ticked off stay visible for this long, so a mistake can be undone.
const GOT_VISIBLE_DAYS = 7;

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

// HubData over Supabase. The client must carry the person's own token or
// session, so every query here is held to their row level security.
export function supabaseHubData(client: SupabaseClient): HubData {
  let memberCache: Member[] | undefined;

  async function members(): Promise<Member[]> {
    if (memberCache) return memberCache;
    const { data, error } = await client
      .from("members")
      .select("id, display_name, role")
      .order("role", { ascending: false })
      .order("display_name");
    if (error) fail("Could not read the family list", error);
    memberCache = (data ?? []).map((m) => ({
      id: m.id as string,
      name: m.display_name as string,
      role: m.role as Role,
    }));
    return memberCache;
  }

  async function nameMap(): Promise<Map<string, string>> {
    return new Map((await members()).map((m) => [m.id, m.name]));
  }

  return {
    async status(): Promise<ConnectionStatus> {
      const { data, error } = await client.rpc("hub_connection_status");
      if (error) fail("Could not check the connection", error);
      const s = (data ?? {}) as Record<string, string>;
      if (s.status === "not_a_member" || !s.member_id) return { status: "not_a_member" };
      const member: Member = { id: s.member_id, name: s.name, role: s.role as Role };
      switch (s.status) {
        case "ok":
          return { status: "ok", member, door: s.door as Door, clientName: s.client_name };
        case "switched_off":
          return { status: "switched_off", member, clientName: s.client_name };
        case "ai_access_off":
          return { status: "ai_access_off", member };
        case "app_session":
          return { status: "app_session", member };
        default:
          return { status: "not_connected", member };
      }
    },

    members,

    async readFile(memberId, options): Promise<PersonalFile | null> {
      const member = (await members()).find((m) => m.id === memberId);
      if (!member) return null;
      const fileQuery = client.from("personal_files").select("about").eq("member_id", memberId).maybeSingle();
      let prefQuery = client
        .from("preferences")
        .select(PREFERENCE_COLUMNS)
        .eq("member_id", memberId)
        .order("category")
        .order("created_at");
      if (!options?.includeRetired) prefQuery = prefQuery.neq("status", "retired");
      const [file, prefs] = await Promise.all([fileQuery, prefQuery]);
      if (file.error) fail("Could not read the file", file.error);
      if (prefs.error) fail("Could not read the file's entries", prefs.error);
      const names = await nameMap();
      return {
        member,
        about: (file.data?.about as string | null | undefined) ?? null,
        preferences: ((prefs.data ?? []) as PreferenceRow[]).map((r) => toPreference(r, names)),
      };
    },

    async addPreference(input: NewPreference): Promise<Preference> {
      const { data, error } = await client
        .from("preferences")
        .insert({
          member_id: input.memberId,
          added_by: input.addedBy,
          category: input.category,
          statement: input.statement,
          detail: input.detail ?? null,
          visibility: input.visibility,
          status: input.status,
          source: input.source,
        })
        .select(PREFERENCE_COLUMNS)
        .single();
      if (error || !data) fail("Could not save the preference", error);
      return toPreference(data as PreferenceRow, await nameMap());
    },

    async setPreferenceStatus(id, status): Promise<Preference | null> {
      const { data, error } = await client
        .from("preferences")
        .update({ status })
        .eq("id", id)
        .select(PREFERENCE_COLUMNS)
        .maybeSingle();
      if (error) fail("Could not update the preference", error);
      return data ? toPreference(data as PreferenceRow, await nameMap()) : null;
    },

    async updateAbout(memberId, about): Promise<boolean> {
      const { data, error } = await client
        .from("personal_files")
        .update({ about })
        .eq("member_id", memberId)
        .select("id");
      if (error) fail("Could not update the file", error);
      return (data ?? []).length > 0;
    },

    async log(entry): Promise<void> {
      const { error } = await client.from("activity_log").insert({
        action: entry.action,
        subject_id: entry.subjectId ?? null,
        target_id: entry.targetId ?? null,
        summary: entry.summary?.slice(0, 240) ?? null,
      });
      // A failed read-log must not break the answer; the write itself is
      // logged by the database regardless of the door.
      if (error) console.error("activity log write failed", error.message);
    },

    async lists(): Promise<HubList[]> {
      const [lists, needed] = await Promise.all([
        client.from("lists").select("id, name, visibility, owner_id").is("archived_at", null).order("created_at"),
        client.from("list_items").select("list_id").eq("status", "needed"),
      ]);
      if (lists.error) fail("Could not read the lists", lists.error);
      if (needed.error) fail("Could not read the lists", needed.error);
      const counts = new Map<string, number>();
      for (const row of needed.data ?? []) {
        counts.set(row.list_id as string, (counts.get(row.list_id as string) ?? 0) + 1);
      }
      return (lists.data ?? []).map((l) => ({
        id: l.id as string,
        name: l.name as string,
        visibility: l.visibility as HubList["visibility"],
        ownerId: l.owner_id as string,
        needed: counts.get(l.id as string) ?? 0,
      }));
    },

    async listItems(listId, options): Promise<ListItem[]> {
      let query = client.from("list_items").select(ITEM_COLUMNS).eq("list_id", listId).order("added_at");
      if (options?.includeGot) {
        const since = new Date(Date.now() - GOT_VISIBLE_DAYS * 86_400_000).toISOString();
        query = query.or(`status.eq.needed,and(status.eq.got,done_at.gte.${since})`);
      } else {
        query = query.eq("status", "needed");
      }
      const { data, error } = await query;
      if (error) fail("Could not read the list", error);
      const names = await nameMap();
      return ((data ?? []) as ItemRow[]).map((r) => toItem(r, names));
    },

    async createList(input): Promise<HubList> {
      const { data, error } = await client
        .from("lists")
        .insert({ name: input.name, visibility: input.visibility, owner_id: input.ownerId })
        .select("id, name, visibility, owner_id")
        .single();
      if (error || !data) fail("Could not start the list", error);
      return {
        id: data.id as string,
        name: data.name as string,
        visibility: data.visibility as HubList["visibility"],
        ownerId: data.owner_id as string,
        needed: 0,
      };
    },

    async addListItems(listId, addedBy, items): Promise<ListItem[]> {
      if (items.length === 0) return [];
      const { data, error } = await client
        .from("list_items")
        .insert(items.map((item) => ({ list_id: listId, item, added_by: addedBy })))
        .select(ITEM_COLUMNS);
      if (error) fail("Could not add to the list", error);
      const names = await nameMap();
      return ((data ?? []) as ItemRow[]).map((r) => toItem(r, names));
    },

    async setListItemStatus(ids, status): Promise<ListItem[]> {
      if (ids.length === 0) return [];
      const { data, error } = await client.from("list_items").update({ status }).in("id", ids).select(ITEM_COLUMNS);
      if (error) fail("Could not update the list", error);
      const names = await nameMap();
      return ((data ?? []) as ItemRow[]).map((r) => toItem(r, names));
    },
  };
}
