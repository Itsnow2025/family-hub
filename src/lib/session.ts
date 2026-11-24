import "server-only";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseHubData } from "@/lib/hub/supabase-data";
import type { HubData, Member } from "@/lib/hub/types";
import { createSessionClient } from "@/lib/supabase/server";

export interface Session {
  supabase: SupabaseClient;
  hub: HubData;
  me: Member | null;
}

// The signed-in person for this request, or null when nobody is signed in.
// `me` is null when someone is signed in but is not a family member.
export async function getSession(): Promise<Session | null> {
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return null;
  const hub = supabaseHubData(supabase);
  const status = await hub.status();
  return { supabase, hub, me: status.status === "app_session" ? status.member : null };
}

export async function requireMember(returnTo: string): Promise<Session & { me: Member }> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (!session.me) redirect("/login?error=not_member");
  return session as Session & { me: Member };
}

// Only same-site paths may be used as a return address after signing in.
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
