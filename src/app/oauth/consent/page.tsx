import { redirect } from "next/navigation";
import { Button, Card, fieldClass, Page } from "@/components/ui";
import {
  blockedByParent,
  displayNameForClient,
  DOOR_NAMES,
  doorForClient,
  findConnection,
} from "@/lib/hub/connected-ais";
import { requireMember } from "@/lib/session";
import { decide } from "./actions";

const ERRORS: Record<string, string> = {
  blocked: "A parent has switched this AI off for you. Ask a parent to switch it back on in Settings.",
  expired: "This connection request has expired. Start again from your AI app.",
  failed: "Something went wrong saving the connection. Try again from your AI app.",
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string; error?: string }>;
}) {
  const { authorization_id: id, error } = await searchParams;
  if (!id) {
    return (
      <Page>
        <Card className="mt-10">This link is missing its connection request. Start again from your AI app.</Card>
      </Page>
    );
  }

  const { supabase, hub, me } = await requireMember(`/oauth/consent?authorization_id=${encodeURIComponent(id)}`);
  const { data, error: detailsError } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (detailsError || !data) {
    return (
      <Page>
        <Card className="mt-10">{ERRORS.expired}</Card>
      </Page>
    );
  }
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  const members = await hub.members();
  const children = members.filter((m) => m.role === "child");
  const existing = await findConnection(supabase, me.id, data.client.id);
  const blocked = blockedByParent(existing, me, members);
  const guessedDoor = doorForClient(data.client.name);
  const appName = displayNameForClient(data.client.name, guessedDoor);
  const calledItself = data.client.name.trim();
  const writes =
    me.role === "parent" && children.length
      ? `Add to your own file and to ${children.map((c) => c.name).join(" and ")}'s`
      : "Add to your own file";

  return (
    <Page>
      <div className="mx-auto mt-8 max-w-md">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Connect {appName}?</h1>
        <p className="mb-5 text-sm text-muted">
          It will act as <strong className="text-foreground">{me.name}</strong> in Family Hub.
        </p>
        {error && ERRORS[error] ? <p className="mb-4 text-sm text-warn">{ERRORS[error]}</p> : null}
        <Card className="space-y-3 text-sm">
          <div>
            <p className="font-medium">It can</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Read what each family member shares with you</li>
              <li>{writes}, and confirm or retire entries there</li>
            </ul>
          </div>
          <div>
            <p className="font-medium">It cannot</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>Delete anything</li>
              <li>Contact anyone, or reach anything outside Family Hub</li>
              <li>See your chats with it, unless you save something here</li>
            </ul>
          </div>
          <p className="text-muted">Every action it takes is logged. You can switch it off any time in Settings.</p>
          <p className="break-all text-xs text-muted">Returns to: {data.redirect_uri}</p>
        </Card>
        <form action={decide} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="authorization_id" value={data.authorization_id} />
          {blocked ? null : (
            <label className="mb-1 block w-full text-sm">
              <span className="mb-1 block text-muted">
                Which AI is this?{calledItself && calledItself !== appName ? ` It calls itself "${calledItself}".` : ""}
              </span>
              <select name="door" defaultValue={guessedDoor} className={fieldClass}>
                <option value="grok">{DOOR_NAMES.grok}</option>
                <option value="claude">{DOOR_NAMES.claude}</option>
                <option value="other_ai">{DOOR_NAMES.other_ai}</option>
              </select>
            </label>
          )}
          {blocked ? null : (
            <Button type="submit" name="decision" value="approve" className="flex-1">
              Connect as {me.name}
            </Button>
          )}
          <Button type="submit" name="decision" value="deny" kind="quiet" className="flex-1">
            {blocked ? "Close" : "Don't connect"}
          </Button>
        </form>
        {blocked ? <p className="mt-3 text-sm text-warn">{ERRORS.blocked}</p> : null}
      </div>
    </Page>
  );
}
