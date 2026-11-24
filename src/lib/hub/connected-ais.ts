import type { SupabaseClient } from "@supabase/supabase-js";
import type { Member } from "./types";

export type AiDoor = "grok" | "claude" | "other_ai";

export function doorForClient(name: string): AiDoor {
  if (/grok|x\.?ai/i.test(name)) return "grok";
  if (/claude|anthropic/i.test(name)) return "claude";
  return "other_ai";
}

export interface ConnectedAiRow {
  id: string;
  member_id: string;
  client_id: string;
  client_name: string;
  door: AiDoor;
  enabled: boolean;
  changed_by: string | null;
  approved_at: string;
  updated_at: string;
}

export async function findConnection(
  supabase: SupabaseClient,
  memberId: string,
  clientId: string,
): Promise<ConnectedAiRow | null> {
  const { data, error } = await supabase
    .from("connected_ais")
    .select("*")
    .eq("member_id", memberId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ConnectedAiRow | null) ?? null;
}

// A child may not reconnect an AI a parent switched off.
export function blockedByParent(row: ConnectedAiRow | null, me: Member, members: Member[]): boolean {
  if (!row || row.enabled || me.role !== "child" || !row.changed_by) return false;
  return members.find((m) => m.id === row.changed_by)?.role === "parent";
}

// Records the AI on the person's list before the sign-in is approved, so the
// database knows which door its requests come through and can switch it off.
export async function recordConnection(
  supabase: SupabaseClient,
  me: Member,
  client: { id: string; name: string },
  existing: ConnectedAiRow | null,
): Promise<void> {
  const door = doorForClient(client.name);
  const name = client.name.trim() || "AI app";
  const result = existing
    ? await supabase.from("connected_ais").update({ enabled: true, client_name: name, door }).eq("id", existing.id)
    : await supabase.from("connected_ais").insert({ member_id: me.id, client_id: client.id, client_name: name, door });
  if (result.error) throw new Error(result.error.message);
}
