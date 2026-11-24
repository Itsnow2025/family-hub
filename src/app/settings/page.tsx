import { headers } from "next/headers";
import { Button, Card, formatWhen, Heading, Nav, Page } from "@/components/ui";
import { CONNECTOR_PATH, FAMILY_TIME_ZONE } from "@/lib/config";
import type { ConnectedAiRow } from "@/lib/hub/connected-ais";
import { requireMember } from "@/lib/session";
import { switchAiAccess, switchConnectedAi } from "./actions";

interface LogRow {
  id: number;
  actor_id: string | null;
  subject_id: string | null;
  door: string;
  action: string;
  summary: string | null;
  created_at: string;
}

const ACTION_LABEL: Record<string, string> = {
  "preference.added": "added a preference",
  "preference.suggested": "suggested a preference",
  "preference.confirmed": "confirmed a preference",
  "preference.retired": "retired a preference",
  "preference.changed": "changed a preference",
  "file.about_changed": "changed an About note",
  "file.read": "read a file",
  "connector.who_am_i": "checked who it is connected as",
  "ai.connected": "connected an AI",
};

const DOOR_LABEL: Record<string, string> = {
  app: "app",
  grok: "Grok",
  claude: "Claude",
  other_ai: "AI",
  system: "system",
};

export default async function SettingsPage() {
  const { supabase, hub, me } = await requireMember("/settings");
  const members = await hub.members();
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? "someone";

  const host = (await headers()).get("x-forwarded-host") ?? (await headers()).get("host") ?? "";
  const proto = (await headers()).get("x-forwarded-proto") ?? "https";
  const connectorUrl = `${proto}://${host}${CONNECTOR_PATH}`;

  const [ais, access, log] = await Promise.all([
    supabase.from("connected_ais").select("*").order("approved_at"),
    supabase.from("members").select("id, display_name, role, ai_access"),
    supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(40),
  ]);
  const connected = (ais.data ?? []) as ConnectedAiRow[];
  const switches = (access.data ?? []) as { id: string; display_name: string; role: string; ai_access: boolean }[];
  const entries = (log.data ?? []) as LogRow[];

  const mayFlipAccess = (row: { id: string; role: string }) =>
    me.role === "parent" && (row.id === me.id || row.role === "child");

  return (
    <>
      <Nav me={me} members={members} current="settings" />
      <Page>
        <Heading sub={`Signed in as ${me.name}.`}>Settings</Heading>

        <Card className="mb-4">
          <h2 className="mb-2 font-medium">Connect your Grok</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>
              In Grok, open <span className="font-medium">grok.com/connectors</span>, choose New Connector, then Custom.
            </li>
            <li>
              Paste this address: <code className="break-all rounded bg-background px-1.5 py-0.5">{connectorUrl}</code>
            </li>
            <li>Grok opens Family Hub. Sign in as yourself and press Connect.</li>
            <li>Ask Grok: &ldquo;Who am I in Family Hub?&rdquo;</li>
          </ol>
          <p className="mt-2 text-sm text-muted">The same address works for Claude and other AI apps that take custom connectors.</p>
        </Card>

        <Card className="mb-4">
          <h2 className="mb-2 font-medium">Connected AIs</h2>
          {connected.length === 0 ? (
            <p className="text-sm text-muted">No AI is connected yet.</p>
          ) : (
            <ul>
              {connected.map((row) => {
                const mine = row.member_id === me.id;
                const canSwitch = mine || me.role === "parent";
                return (
                  <li key={row.id} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
                    <div className="flex-1">
                      <p>
                        {row.client_name} <span className="text-muted">for {mine ? "you" : nameOf(row.member_id)}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {row.enabled ? "On" : `Off, switched off by ${row.changed_by === me.id ? "you" : nameOf(row.changed_by)}`} ·
                        connected {formatWhen(row.approved_at, FAMILY_TIME_ZONE)}
                      </p>
                    </div>
                    {canSwitch ? (
                      <form action={switchConnectedAi}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="enabled" value={row.enabled ? "off" : "on"} />
                        <Button kind={row.enabled ? "warn" : "quiet"} className="min-h-8 px-3 text-xs">
                          {row.enabled ? "Switch off" : "Switch on"}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="mb-4">
          <h2 className="mb-1 font-medium">AI access</h2>
          <p className="mb-3 text-sm text-muted">
            Switching this off stops every AI acting for that person, whatever they have connected.
          </p>
          <ul>
            {switches.map((row) => (
              <li key={row.id} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
                <p className="flex-1">
                  {row.display_name} <span className="text-sm text-muted">{row.ai_access ? "on" : "off"}</span>
                </p>
                {mayFlipAccess(row) ? (
                  <form action={switchAiAccess}>
                    <input type="hidden" name="member_id" value={row.id} />
                    <input type="hidden" name="ai_access" value={row.ai_access ? "off" : "on"} />
                    <Button kind={row.ai_access ? "warn" : "quiet"} className="min-h-8 px-3 text-xs">
                      {row.ai_access ? "Switch off" : "Switch on"}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-1 font-medium">Activity</h2>
          <p className="mb-3 text-sm text-muted">
            {me.role === "parent" ? "Everything anyone did, newest first." : "What you did and what touched your file."}
          </p>
          {entries.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {entries.map((e) => (
                <li key={e.id}>
                  <span className="text-muted">{formatWhen(e.created_at, FAMILY_TIME_ZONE)}</span>{" "}
                  <span className="font-medium">{nameOf(e.actor_id)}</span> via {DOOR_LABEL[e.door] ?? e.door}{" "}
                  {ACTION_LABEL[e.action] ?? e.action}
                  {e.subject_id && e.subject_id !== e.actor_id ? ` in ${nameOf(e.subject_id)}'s file` : ""}
                  {e.summary && e.action.startsWith("preference") ? (
                    <span className="text-muted">: {e.summary}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Page>
    </>
  );
}
