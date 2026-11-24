import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConnectionStatus,
  Door,
  HubData,
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
  };
}
