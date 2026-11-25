import { Button, Card, fieldClass, Heading, Nav, Page } from "@/components/ui";
import { goalTree } from "@/lib/hub/brain-tools";
import { canLeadGoal, canWriteFile, type Entry, type EntryKind, type Goal } from "@/lib/hub/types";
import { addDays, formatDate, formatDay, todayIn, weekStartOf } from "@/lib/hub/week";
import { requireMember } from "@/lib/session";
import { addGoal, logEntry, setGoalStatus, withdrawEntry } from "./actions";

const KIND_LABEL: Record<EntryKind, string> = {
  win: "Win",
  learning: "Learning",
  gratitude: "Gratitude",
  made: "Made",
  health: "Health",
  note: "Note",
};

const KIND_HINT: Record<EntryKind, string> = {
  win: "Any win, however small",
  learning: "What something taught you",
  gratitude: "Who or what you're thankful for",
  made: "Something you built or created",
  health: "A health issue (seen by you and the parents)",
  note: "Anything else worth keeping",
};

function EntryRow({ entry, canWithdraw }: { entry: Entry; canWithdraw: boolean }) {
  return (
    <li className="flex gap-3 border-t border-line py-2 first:border-t-0">
      <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wide text-accent">{KIND_LABEL[entry.kind]}</span>
      <div className="flex-1">
        <p>{entry.body}</p>
        <p className="text-xs text-muted">
          {entry.who}, {formatDay(entry.happenedOn)}
          {entry.thanksTo ? ` · thanks to ${entry.thanksTo}` : ""}
          {entry.tool ? ` · with ${entry.tool}` : ""}
        </p>
      </div>
      {canWithdraw ? (
        <form action={withdrawEntry}>
          <input type="hidden" name="id" value={entry.id} />
          <button className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-background" aria-label="Withdraw this entry">
            Withdraw
          </button>
        </form>
      ) : null}
    </li>
  );
}

function GoalBlock({ goal, entries, mayUpdate }: { goal: Goal; entries: Entry[]; mayUpdate: boolean }) {
  return (
    <Card className="mb-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{goal.kind}</span>
        <h3 className="font-semibold">{goal.title}</h3>
        {goal.status === "achieved" ? <span className="text-sm text-accent">Achieved</span> : null}
      </div>
      <p className="text-sm text-muted">
        {goal.lead} leads{goal.team.length ? ` with ${goal.team.join(" and ")}` : ""}
        {goal.targetDate ? ` · by ${formatDate(goal.targetDate)}` : ""}
      </p>
      {entries.length ? (
        <ul className="mt-2">
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} canWithdraw={false} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No news this week.</p>
      )}
      {mayUpdate && goal.status === "active" ? (
        <form action={setGoalStatus} className="mt-2 flex gap-2">
          <input type="hidden" name="id" value={goal.id} />
          <Button name="status" value="achieved" kind="quiet" className="min-h-8 px-3 text-xs">
            Achieved
          </Button>
          <Button name="status" value="paused" kind="quiet" className="min-h-8 px-3 text-xs">
            Pause
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export default async function BrainPage() {
  const { hub, me } = await requireMember("/brain");
  const today = todayIn();
  const weekStart = weekStartOf(today);
  const [members, goals, entries, reviews] = await Promise.all([
    hub.members(),
    hub.goals({ includeClosed: true }),
    hub.entries({ from: weekStart, to: addDays(weekStart, 6) }),
    hub.reviews(weekStart),
  ]);
  const writable = members.filter((m) => canWriteFile(me, m));
  const leadable = members.filter((m) => canLeadGoal(me, m));
  const openGoals = goals.filter((g) => g.status === "active" || g.status === "paused");
  const byGoal = new Map<string, Entry[]>();
  const loose: Entry[] = [];
  for (const e of entries) {
    if (e.kind === "gratitude") continue;
    if (e.goalId && goals.some((g) => g.id === e.goalId)) byGoal.set(e.goalId, [...(byGoal.get(e.goalId) ?? []), e]);
    else loose.push(e);
  }
  const shownGoals = goals.filter((g) => g.status === "active" || byGoal.has(g.id));
  const gratitude = entries.filter((e) => e.kind === "gratitude");
  const mayUpdate = (g: Goal) =>
    g.leadId === me.id || g.teamIds.includes(me.id) || (me.role === "parent" && members.find((m) => m.id === g.leadId)?.role === "child");

  return (
    <>
      <Nav me={me} members={members} current="brain" />
      <Page>
        <Heading sub={`This week: ${formatDay(weekStart)} to ${formatDay(addDays(weekStart, 6), true)}. Every win counts.`}>
          Family Brain
        </Heading>

        <Card className="mb-6">
          <h2 className="mb-3 font-medium">Log it</h2>
          <form action={logEntry} className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(KIND_LABEL) as EntryKind[]).map((kind, i) => (
                <label key={kind} className="cursor-pointer">
                  <input type="radio" name="kind" value={kind} defaultChecked={i === 0} className="peer sr-only" />
                  <span className="inline-block rounded-full border border-line px-3 py-1.5 text-sm peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-ink" title={KIND_HINT[kind]}>
                    {KIND_LABEL[kind]}
                  </span>
                </label>
              ))}
            </div>
            <textarea name="body" required maxLength={2000} rows={2} className={fieldClass} placeholder="What happened, in your own words" />
            <div className="grid gap-2 sm:grid-cols-2">
              <select name="goal_id" defaultValue="" className={fieldClass} aria-label="Part of a goal">
                <option value="">Not part of a goal</option>
                {openGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              <select name="thanks_to" defaultValue="" className={fieldClass} aria-label="Thanks to">
                <option value="">Nobody to thank (this time)</option>
                {members
                  .filter((m) => m.id !== me.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      Thanks to {m.name}
                    </option>
                  ))}
              </select>
              <input name="tool" maxLength={60} className={fieldClass} placeholder="Made with (Grok, Claude, Canva…)" />
              {writable.length > 1 ? (
                <select name="member_id" defaultValue={me.id} className={fieldClass} aria-label="Whose journal">
                  {writable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === me.id ? "My journal" : `${m.name}'s journal`}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="hidden" name="member_id" value={me.id} />
              )}
            </div>
            <Button type="submit">Log it</Button>
          </form>
        </Card>

        <h2 className="mb-2 text-lg font-semibold">Dreams and goals this week</h2>
        {shownGoals.length === 0 ? (
          <Card className="mb-4 text-muted">No dreams or goals yet. Add one below, or tell your AI.</Card>
        ) : (
          shownGoals.map((g) => (
            <GoalBlock key={g.id} goal={g} entries={byGoal.get(g.id) ?? []} mayUpdate={mayUpdate(g)} />
          ))
        )}

        {loose.length ? (
          <Card className="mb-4">
            <h2 className="mb-2 font-medium">Also this week</h2>
            <ul>
              {loose.map((e) => (
                <EntryRow key={e.id} entry={e} canWithdraw={canWriteFile(me, members.find((m) => m.id === e.memberId)!)} />
              ))}
            </ul>
          </Card>
        ) : null}

        {gratitude.length ? (
          <Card className="mb-4">
            <h2 className="mb-2 font-medium">Gratitude</h2>
            <ul>
              {gratitude.map((e) => (
                <EntryRow key={e.id} entry={e} canWithdraw={canWriteFile(me, members.find((m) => m.id === e.memberId)!)} />
              ))}
            </ul>
          </Card>
        ) : null}

        {reviews.length ? (
          <Card className="mb-4">
            <h2 className="mb-2 font-medium">Weekly reviews</h2>
            {reviews.map((r) => (
              <div key={r.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                <p className="mb-1 text-sm font-medium">{r.who}</p>
                <p className="whitespace-pre-wrap text-sm">{r.body}</p>
                {r.aiSkill ? <p className="mt-1 text-sm text-muted">AI skill grown: {r.aiSkill}</p> : null}
                {r.nextTry ? <p className="text-sm text-muted">To try next week: {r.nextTry}</p> : null}
              </div>
            ))}
          </Card>
        ) : (
          <Card className="mb-4 text-sm text-muted">
            On Friday, ask your AI: &ldquo;Run my weekly review in the Family Brain.&rdquo;
          </Card>
        )}

        <Card>
          <h2 className="mb-3 font-medium">Add a dream or goal</h2>
          <form action={addGoal} className="space-y-3">
            <input name="title" required maxLength={200} className={fieldClass} placeholder="Such as: Ride at the Tamworth Futurity" />
            <div className="grid gap-2 sm:grid-cols-2">
              <select name="kind" defaultValue="goal" className={fieldClass} aria-label="Kind">
                <option value="dream">A dream</option>
                <option value="goal">A goal</option>
                <option value="milestone">A milestone</option>
              </select>
              <select name="lead_id" defaultValue={me.id} className={fieldClass} aria-label="Who leads it">
                {leadable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === me.id ? "I lead it" : `${m.name} leads it`}
                  </option>
                ))}
              </select>
              <input name="target_date" type="date" className={fieldClass} aria-label="By when" />
              <select name="parent_id" defaultValue="" className={fieldClass} aria-label="Part of">
                <option value="">Not part of another</option>
                {openGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    Part of: {g.title}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 text-muted">Team</legend>
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-1.5">
                  <input type="checkbox" name="team" value={m.id} /> {m.name}
                </label>
              ))}
            </fieldset>
            <input name="why" maxLength={1000} className={fieldClass} placeholder="Why it matters (optional)" />
            <Button type="submit">Add</Button>
          </form>
          {goals.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-muted">All dreams and goals</summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{goalTree(goals).join("\n").replace(/; id [0-9a-f-]+/g, "")}</pre>
            </details>
          ) : null}
        </Card>
      </Page>
    </>
  );
}
