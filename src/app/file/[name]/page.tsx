import { notFound } from "next/navigation";
import { Button, Card, fieldClass, formatWhen, Heading, Nav, Page } from "@/components/ui";
import { FAMILY_TIME_ZONE } from "@/lib/config";
import { visibilityLabel } from "@/lib/hub/tools";
import { canWriteFile, type Member, type Preference } from "@/lib/hub/types";
import { requireMember } from "@/lib/session";
import { addPreference, changeStatus, updateAbout } from "../actions";

const DOOR_LABEL: Record<Preference["door"], string> = {
  app: "the app",
  grok: "Grok",
  claude: "Claude",
  other_ai: "an AI",
  system: "the system",
};

function Entry({ p, owner, editable }: { p: Preference; owner: Member; editable: boolean }) {
  return (
    <li className="border-t border-line py-3 first:border-t-0 first:pt-0">
      <p>{p.statement}</p>
      {p.detail ? <p className="mt-0.5 text-sm text-muted">{p.detail}</p> : null}
      <p className="mt-1 text-xs text-muted">
        Visible to {visibilityLabel(p.visibility, owner)} · {p.addedBy ? `${p.addedBy} via ` : "via "}
        {DOOR_LABEL[p.door]} · {formatWhen(p.createdAt, FAMILY_TIME_ZONE)}
      </p>
      {editable ? (
        <form action={changeStatus} className="mt-2 flex gap-2">
          <input type="hidden" name="id" value={p.id} />
          {p.status === "suggested" ? (
            <Button name="status" value="confirmed" kind="primary" className="min-h-8 px-3 text-xs">
              Confirm
            </Button>
          ) : null}
          {p.status !== "retired" ? (
            <Button name="status" value="retired" kind="quiet" className="min-h-8 px-3 text-xs">
              {p.status === "suggested" ? "Not true" : "No longer true"}
            </Button>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

export default async function FilePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const { hub, me } = await requireMember(`/file/${name}`);
  const members = await hub.members();
  const owner = members.find((m) => m.name.toLowerCase() === decodeURIComponent(name).toLowerCase());
  if (!owner) notFound();
  const file = await hub.readFile(owner.id);
  if (!file) notFound();
  const editable = canWriteFile(me, owner);
  const confirmed = file.preferences.filter((p) => p.status === "confirmed");
  const suggested = file.preferences.filter((p) => p.status === "suggested");
  const categories = [...new Set(confirmed.map((p) => p.category))];
  const yours = owner.id === me.id;

  return (
    <>
      <Nav me={me} members={members} current={owner.id} />
      <Page>
        <Heading sub={yours ? "Your personal file. Your AI reads it to know you better." : `${owner.name}'s personal file, as shared with you.`}>
          {yours ? "Your file" : `${owner.name}'s file`}
        </Heading>

        <Card className="mb-4">
          <h2 className="mb-2 text-sm font-medium text-muted">About</h2>
          {editable ? (
            <form action={updateAbout} className="space-y-2">
              <input type="hidden" name="member_id" value={owner.id} />
              <textarea
                name="about"
                defaultValue={file.about ?? ""}
                rows={3}
                maxLength={1000}
                className={fieldClass}
                placeholder={yours ? "A few lines about you, in your own words." : `A few lines about ${owner.name}.`}
              />
              <Button kind="quiet" type="submit">
                Save
              </Button>
            </form>
          ) : (
            <p>{file.about || <span className="text-muted">Nothing written yet.</span>}</p>
          )}
        </Card>

        {suggested.length ? (
          <Card className="mb-4">
            <h2 className="mb-2 text-sm font-medium text-muted">
              Suggestions waiting for {yours ? "you" : owner.name} to confirm
            </h2>
            <ul>
              {suggested.map((p) => (
                <Entry key={p.id} p={p} owner={owner} editable={editable} />
              ))}
            </ul>
          </Card>
        ) : null}

        {categories.length === 0 ? (
          <Card className="mb-4 text-muted">
            {yours
              ? 'No preferences yet. Add one below, or tell your AI "remember that I…".'
              : `Nothing in ${owner.name}'s file is shared with you yet.`}
          </Card>
        ) : (
          categories.map((category) => (
            <Card key={category} className="mb-4">
              <h2 className="mb-2 text-sm font-medium capitalize text-muted">{category}</h2>
              <ul>
                {confirmed
                  .filter((p) => p.category === category)
                  .map((p) => (
                    <Entry key={p.id} p={p} owner={owner} editable={editable} />
                  ))}
              </ul>
            </Card>
          ))
        )}

        {editable ? (
          <Card>
            <h2 className="mb-3 text-sm font-medium text-muted">Add a preference</h2>
            <form action={addPreference} className="space-y-3">
              <input type="hidden" name="member_id" value={owner.id} />
              <input name="category" required maxLength={40} className={fieldClass} placeholder="Category, such as food, work, horses" />
              <textarea name="statement" required maxLength={500} rows={2} className={fieldClass} placeholder="The preference, in plain words" />
              <input name="detail" maxLength={2000} className={fieldClass} placeholder="Detail (optional)" />
              <select name="visibility" defaultValue="family" className={fieldClass}>
                <option value="family">Visible to the whole family</option>
                <option value="parents">{visibilityLabel("parents", owner)[0].toUpperCase() + visibilityLabel("parents", owner).slice(1)} only</option>
                {owner.role === "child" ? null : <option value="private">Only {owner.name}</option>}
              </select>
              <Button type="submit">Add</Button>
            </form>
          </Card>
        ) : null}
      </Page>
    </>
  );
}
