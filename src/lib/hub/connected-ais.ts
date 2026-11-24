import type { SupabaseClient } from "@supabase/supabase-js";
import type { Member } from "./types";

export type AiDoor = "grok" | "claude" | "other_ai";

// Grok Bot introduces itself to connectors as "Cursor".
export function doorForClient(name: string): AiDoor {
  if (/grok|x\.?ai|cursor/i.test(name)) return "grok";
  if (/claude|anthropic/i.test(name)) return "claude";
  return "other_ai";
}

export const DOOR_NAMES: Record<AiDoor, string> = { grok: "Grok", claude: "Claude", other_ai: "Another AI" };

// The name shown to the family for a connected AI.
export function displayNameForClient(name: string, door: AiDoor): string {
  const given = name.trim();
  if (door === "grok" && /cursor/i.test(given)) return "Grok Bot";
  return given || DOOR_NAMES[door];
}

export function isAiDoor(value: unknown): value is AiDoor {
  return value === "grok" || value === "claude" || value === "other_ai";
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
  chosenDoor?: AiDoor,
): Promise<void> {
  const door = chosenDoor ?? doorForClient(client.name);
  const name = displayNameForClient(client.name, door);
  const result = existing
    ? await supabase.from("connected_ais").update({ enabled: true, client_name: name, door }).eq("id", existing.id)
    : await supabase.from("connected_ais").insert({ member_id: me.id, client_id: client.id, client_name: name, door });
  if (result.error) throw new Error(result.error.message);
}
