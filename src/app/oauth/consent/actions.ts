"use server";

import { redirect } from "next/navigation";
import { blockedByParent, findConnection, recordConnection } from "@/lib/hub/connected-ais";
import { requireMember } from "@/lib/session";

function consentPath(id: string, error?: string): string {
  const base = `/oauth/consent?authorization_id=${encodeURIComponent(id)}`;
  return error ? `${base}&error=${error}` : base;
}

export async function decide(formData: FormData): Promise<void> {
  const id = String(formData.get("authorization_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id) redirect("/");
  const { supabase, hub, me } = await requireMember(consentPath(id));

  if (decision !== "approve") {
    const { data, error } = await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (error || !data) redirect(consentPath(id, "failed"));
    redirect(data.redirect_url);
  }

  const details = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (details.error || !details.data) redirect(consentPath(id, "expired"));
  if (!("authorization_id" in details.data)) redirect(details.data.redirect_url);
  const client = details.data.client;

  let failed: string | undefined;
  try {
    const existing = await findConnection(supabase, me.id, client.id);
    if (blockedByParent(existing, me, await hub.members())) failed = "blocked";
    else await recordConnection(supabase, me, client, existing);
  } catch {
    failed = "failed";
  }
  if (failed) redirect(consentPath(id, failed));

  const { data, error } = await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true });
  if (error || !data) redirect(consentPath(id, "failed"));
  await hub.log({ action: "ai.connected", subjectId: me.id, summary: `${me.name} connected ${client.name}` });
  redirect(data.redirect_url);
}
