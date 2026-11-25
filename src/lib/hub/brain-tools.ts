import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  begin,
  guarded,
  isResult,
  listNames,
  personField,
  problem,
  READ_ONLY,
  resolvePerson,
  text,
  WRITES,
  type DataForAuth,
  type ToolContext,
} from "./tools";
import {
  canLeadGoal,
  canWriteFile,
  type Entry,
  type EntryKind,
  type Goal,
  type GoalStatus,
  type HubData,
  type Member,
  type Review,
  type Visibility,
} from "./types";
import { addDays, formatDate, formatDay, isDay, todayIn, weekStartOf } from "./week";

// ---------------------------------------------------------------------------
// The family's way of working, given to every AI that connects. It is the
// method, not a scoreboard: every win counts, there is no failure, gratitude
// matters, and the family is a team.
// ---------------------------------------------------------------------------
export const BRAIN_INSTRUCTIONS = `Family Brain: how this family works
- Celebrate every win, however small. Log it with log_entry kind win.
- There is no failure, only learnings. When something did not go to plan, log what it taught, kind learning.
- Remember gratitude. When someone is thankful, log it, and name who they are thankful to.
- When someone builds or creates something, with or without AI, log it, kind made, and name the tool.
- Health issues are logged when someone mentions one, kind health. They are seen only by that person and the parents unless they say otherwise.
- It is a team, not a competition. Never count, rank or compare people.

Getting work into the Brain
- The Brain cannot see chats. When the person finishes something worth keeping, offer: "Shall I log that to the Brain?"
- When they say "log this" or "save this to the Brain", log the gist in their words, linked to a goal when one fits.

Dreams and goals
- Use set_goal for a dream, goal or milestone. Every goal has a lead; others can join as the team.
- Use catch_me_up at the start of a working session.

The weekly review
- When someone asks for their weekly review, call week_in_review, write the review following its guidance, read it back, and save it with save_review only when they are happy with it.`;

const KIND_LABEL: Record<EntryKind, string> = {
  win: "Win",
  learning: "Learning",
  gratitude: "Gratitude",
  made: "Made",
  health: "Health",
  note: "Note",
};

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "active",
  achieved: "achieved",
  paused: "paused",
  let_go: "let go",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const visibilityField = z
  .enum(["family", "parents", "private"])
  .optional()
  .describe(
    "Who can see it: family (all three), parents (the person and both parents), or private (the person only; not for Gigi). Left out: parents for health, family for everything else.",
  );

const whenField = z
  .string()
  .trim()
  .max(20)
  .optional()
  .describe('The day it happened: "today", "yesterday" or YYYY-MM-DD. Left out means today.');

const goalRefField = z
  .string()
  .trim()
  .max(200)
  .optional()
  .describe("The goal it belongs to: its id or a few words of its title.");

const peopleField = z.array(z.string().trim().min(1).max(40)).max(3);

// ---------------------------------------------------------------------------
// Helpers shared by the tools
// ---------------------------------------------------------------------------

export function resolveDay(value: string | undefined, today: string): string | string[] {
  const v = value?.trim().toLowerCase();
  if (!v || v === "today") return today;
  if (v === "yesterday") return addDays(today, -1);
  if (isDay(v)) return v > today ? ["That day is in the future. Use today or an earlier day."] : v;
  return [`"${value}" is not a day I understand. Use today, yesterday or YYYY-MM-DD.`];
}

// Finds a goal by id or by words of its title. Never guesses between two.
export function findGoal(goals: Goal[], ref: string): Goal | string {
  const wanted = ref.trim();
  if (UUID.test(wanted)) {
    return goals.find((g) => g.id === wanted) ?? "No goal with that id is shared with you.";
  }
  const lower = wanted.toLowerCase();
  const exact = goals.filter((g) => g.title.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const loose = goals.filter((g) => {
    const title = g.title.toLowerCase();
    return title.includes(lower) || (words.length > 0 && words.every((w) => title.includes(w)));
  });
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    return `More than one goal matches "${ref}": ${loose.map((g) => `${g.title} (id ${g.id})`).join("; ")}. Say which.`;
  }
  return goals.length
    ? `No goal matches "${ref}". The goals are: ${goals.map((g) => g.title).join("; ")}.`
    : "There are no goals yet. Set one with set_goal.";
}

function resolvePeople(members: Member[], me: Member, names: string[] | undefined): Member[] | string {
  const out: Member[] = [];
  for (const name of names ?? []) {
    const found = resolvePerson(members, me, name);
    if (typeof found === "string") return found;
    if (!out.some((m) => m.id === found.id)) out.push(found);
  }
  return out;
}

function goalLine(goal: Goal): string {
  const team = goal.team.length ? `; with ${listNames(goal.team.map((name) => ({ name }) as Member))}` : "";
  const date = goal.targetDate ? `, by ${formatDate(goal.targetDate)}` : "";
  const status = goal.status === "active" ? "" : ` [${STATUS_LABEL[goal.status]}]`;
  return `${goal.kind === "dream" ? "Dream" : goal.kind === "milestone" ? "Milestone" : "Goal"}: ${goal.title}${date} (${goal.lead} leads${team})${status}`;
}

function entryLine(entry: Entry, withPerson = true): string {
  const who = withPerson ? `${entry.who}, ` : "";
  const day = formatDay(entry.happenedOn);
  const thanks = entry.thanksTo ? ` (thanks to ${entry.thanksTo})` : "";
  const tool = entry.tool ? ` (with ${entry.tool})` : "";
  return `- ${KIND_LABEL[entry.kind]} (${who}${day}): ${entry.body}${thanks}${tool}`;
}

// Goals listed under their dream, deepest last.
export function goalTree(goals: Goal[]): string[] {
  const byParent = new Map<string | null, Goal[]>();
  const ids = new Set(goals.map((g) => g.id));
  for (const g of goals) {
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), g]);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const g of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}- ${goalLine(g)}; id ${g.id}${g.measure ? `\n${"  ".repeat(depth)}  Measure: ${g.measure}` : ""}`);
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

// ---------------------------------------------------------------------------
// The weekly review pack: organised by dream and goal, never by score.
// ---------------------------------------------------------------------------
export function weekPack(input: {
  weekStart: string;
  today: string;
  me: Member;
  members: Member[];
  goals: Goal[];
  entries: Entry[];
  reviews: Review[];
  lastWeekReviews: Review[];
}): string {
  const { weekStart, me, members, goals, entries, reviews, lastWeekReviews } = input;
  const weekEnd = addDays(weekStart, 6);
  const lines: string[] = [`Family week: ${formatDay(weekStart)} to ${formatDay(weekEnd, true)}`];

  const goalById = new Map(goals.map((g) => [g.id, g]));
  const tied = new Map<string, Entry[]>();
  const loose: Entry[] = [];
  for (const e of entries) {
    if (e.kind === "gratitude" || e.kind === "health") continue;
    if (e.goalId && goalById.has(e.goalId)) tied.set(e.goalId, [...(tied.get(e.goalId) ?? []), e]);
    else loose.push(e);
  }

  lines.push("", "Dreams and goals");
  const active = goals.filter((g) => g.status === "active");
  const achievedThisWeek = goals.filter((g) => g.status === "achieved" && tied.has(g.id));
  for (const g of [...achievedThisWeek, ...active]) {
    const moved = tied.get(g.id) ?? [];
    lines.push(`* ${goalLine(g)}`);
    if (moved.length) lines.push(...moved.map((e) => `  ${entryLine(e)}`));
    else lines.push("  No news this week.");
  }
  if (goals.length === 0) lines.push("No dreams or goals set yet.");

  if (loose.length) lines.push("", "Also this week", ...loose.map((e) => entryLine(e)));

  const gratitude = entries.filter((e) => e.kind === "gratitude");
  if (gratitude.length) lines.push("", "Gratitude", ...gratitude.map((e) => entryLine(e)));

  const made = entries.filter((e) => e.kind === "made");
  if (made.length) lines.push("", "Built and created this week", ...made.map((e) => entryLine(e)));

  const health = entries.filter((e) => e.kind === "health");
  if (health.length) {
    lines.push("", "Health (shared only with those allowed to see it)", ...health.map((e) => entryLine(e)));
  }

  const helped = entries.filter((e) => e.thanksTo);
  if (helped.length) {
    lines.push("", "Who helped whom", ...helped.map((e) => `- ${e.who} thanked ${e.thanksTo}: ${e.body}`));
  }

  if (lastWeekReviews.length) {
    lines.push("", "Things to try, from last week's reviews");
    for (const r of lastWeekReviews) if (r.nextTry) lines.push(`- ${r.who}: ${r.nextTry}`);
  }

  if (reviews.length) {
    lines.push("", "Reviews already saved this week");
    for (const r of reviews) lines.push(`- ${r.who}${r.aiSkill ? `; AI skill grown: ${r.aiSkill}` : ""}`);
  }

  const children = members.filter((m) => m.role === "child").map((m) => m.name);
  const learners = ["Ferique", ...children].filter((n) => members.some((m) => m.name === n));
  lines.push(
    "",
    "How to write the review",
    `You are writing ${me.name}'s review for this week, as their AI.`,
    "1. Start with the wins, every one, however small. Celebrate them by name.",
    "2. Tell the story by dream and goal: what moved, and who helped whom.",
    "3. Turn anything that did not go to plan into what it taught. Never call it a failure.",
    "4. Include the gratitude, in the family's own words.",
    "5. Health: mention it with care, only if this person wants it in their review.",
    `6. For ${learners.length ? listNames(learners.map((name) => ({ name }) as Member)) : "each person"}: name one AI or building skill that grew this week, and one thing to try next week. Save them as ai_skill and next_try.`,
    "7. Never count, rank or compare people. It is a team.",
    "8. Read it back, change what they want changed, then save it with save_review.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function memberOrProblem(data: HubData, me: Member, person: string | undefined) {
  return resolvePerson(await data.members(), me, person);
}

export function registerBrainTools(server: McpServer, dataFor: DataForAuth, today: () => string = () => todayIn()): void {
  server.registerTool(
    "log_entry",
    {
      title: "Log to the Brain",
      description:
        "Saves something that happened to the family's journal. kind: win (any win, however small), learning (what something taught; there is no failure), gratitude, made (something built or created; name the tool), health (a health issue experienced), note. Use the person's own words.",
      inputSchema: z.object({
        kind: z.enum(["win", "learning", "gratitude", "made", "health", "note"]),
        what: z.string().trim().min(1).max(2000).describe("What happened, in the person's own words."),
        goal: goalRefField,
        thanks_to: z.string().trim().max(40).optional().describe("Who they are thankful to, or who helped."),
        tool: z.string().trim().max(60).optional().describe("For made: the tool used, such as Grok, Claude or Canva."),
        when: whenField,
        person: personField,
        visibility: visibilityField,
      }),
      annotations: WRITES,
    },
    async (
      args: {
        kind: EntryKind;
        what: string;
        goal?: string;
        thanks_to?: string;
        tool?: string;
        when?: string;
        person?: string;
        visibility?: Visibility;
      },
      ctx: ToolContext,
    ) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const members = await data.members();
        const owner = resolvePerson(members, me, args.person);
        if (typeof owner === "string") return problem(owner);
        if (!canWriteFile(me, owner)) {
          return problem(`${owner.name}'s journal is ${owner.name}'s to write in. Log it in your own, and name ${owner.name} as who helped.`);
        }
        if (args.visibility === "private" && owner.role === "child") {
          return problem(`${owner.name}'s journal has no private entries. Use family or parents.`);
        }
        const day = resolveDay(args.when, today());
        if (Array.isArray(day)) return problem(day[0]);
        let goalId: string | null = null;
        let goalTitle = "";
        if (args.goal) {
          const goal = findGoal(await data.goals(), args.goal);
          if (typeof goal === "string") return problem(goal);
          goalId = goal.id;
          goalTitle = goal.title;
        }
        let thanksToId: string | null = null;
        if (args.thanks_to) {
          const helper = resolvePerson(members, me, args.thanks_to);
          if (typeof helper === "string") return problem(helper);
          thanksToId = helper.id;
        }
        const entry = await data.addEntry({
          memberId: owner.id,
          addedBy: me.id,
          kind: args.kind,
          body: args.what,
          goalId,
          thanksToId,
          tool: args.tool || null,
          happenedOn: day,
          visibility: args.visibility,
        });
        const whose = owner.id === me.id ? "your" : `${owner.name}'s`;
        const seenBy =
          entry.visibility === "family"
            ? "the whole family"
            : entry.visibility === "private"
              ? `only ${owner.name}`
              : owner.role === "parent"
                ? "the parents"
                : `${owner.name} and the parents`;
        const cheer = args.kind === "win" ? " That's a win worth celebrating." : "";
        return text(
          `Logged to ${whose} journal for ${formatDay(entry.happenedOn)}: ${KIND_LABEL[entry.kind].toLowerCase()}, "${entry.body}"` +
            `${goalTitle ? `\nPart of: ${goalTitle}` : ""}${entry.thanksTo ? `\nThanks to: ${entry.thanksTo}` : ""}` +
            `${entry.tool ? `\nMade with: ${entry.tool}` : ""}\nSeen by ${seenBy}.${cheer}\nid ${entry.id}`,
        );
      }),
  );

  server.registerTool(
    "set_goal",
    {
      title: "Set a dream or goal",
      description:
        "Adds a dream, goal or milestone. Every goal has a lead (the person by default) and can have a team. Use part_of to put a goal under a dream, or a milestone under a goal.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(200),
        kind: z.enum(["dream", "goal", "milestone"]).optional().describe("Defaults to goal."),
        lead: personField,
        team: peopleField.optional().describe("Others working on it with the lead."),
        why: z.string().trim().max(1000).optional().describe("Why it matters, in their words."),
        measure: z.string().trim().max(300).optional().describe("How we'll know it's done."),
        target_date: z.string().trim().max(10).optional().describe("YYYY-MM-DD."),
        part_of: goalRefField.describe("The dream or goal this sits under: its id or a few words of its title."),
        visibility: visibilityField,
      }),
      annotations: WRITES,
    },
    async (
      args: {
        title: string;
        kind?: Goal["kind"];
        lead?: string;
        team?: string[];
        why?: string;
        measure?: string;
        target_date?: string;
        part_of?: string;
        visibility?: Visibility;
      },
      ctx: ToolContext,
    ) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const members = await data.members();
        const lead = resolvePerson(members, me, args.lead);
        if (typeof lead === "string") return problem(lead);
        if (!canLeadGoal(me, lead)) {
          return problem(`Only ${lead.name} can set a goal that ${lead.name} leads. You can lead it and add ${lead.name} to the team.`);
        }
        if (args.visibility === "private" && lead.role === "child") {
          return problem(`${lead.name}'s goals cannot be private. Use family or parents.`);
        }
        if (args.target_date && !isDay(args.target_date)) return problem("Give the target date as YYYY-MM-DD.");
        const team = resolvePeople(members, me, args.team);
        if (typeof team === "string") return problem(team);
        let parentId: string | null = null;
        if (args.part_of) {
          const parent = findGoal(await data.goals(), args.part_of);
          if (typeof parent === "string") return problem(parent);
          parentId = parent.id;
        }
        const goal = await data.addGoal({
          title: args.title,
          kind: args.kind,
          leadId: lead.id,
          createdBy: me.id,
          teamIds: team.map((m) => m.id),
          why: args.why || null,
          measure: args.measure || null,
          targetDate: args.target_date || null,
          parentId,
          visibility: args.visibility,
        });
        return text(`Saved. ${goalLine(goal)}\nid ${goal.id}`);
      }),
  );

  server.registerTool(
    "update_goal",
    {
      title: "Update a goal",
      description:
        "Changes a goal: mark it achieved (celebrate it), pause it, let it go (a choice, never a failure), change its date, measure or wording, or add people to its team.",
      inputSchema: z.object({
        goal: z.string().trim().min(1).max(200).describe("Its id or a few words of its title."),
        status: z.enum(["active", "achieved", "paused", "let_go"]).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        why: z.string().trim().max(1000).optional(),
        measure: z.string().trim().max(300).optional(),
        target_date: z.string().trim().max(10).optional().describe("YYYY-MM-DD."),
        add_people: peopleField.optional(),
      }),
      annotations: WRITES,
    },
    async (
      args: {
        goal: string;
        status?: GoalStatus;
        title?: string;
        why?: string;
        measure?: string;
        target_date?: string;
        add_people?: string[];
      },
      ctx: ToolContext,
    ) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const found = findGoal(await data.goals({ includeClosed: true }), args.goal);
        if (typeof found === "string") return problem(found);
        if (args.target_date && !isDay(args.target_date)) return problem("Give the target date as YYYY-MM-DD.");
        const people = resolvePeople(await data.members(), me, args.add_people);
        if (typeof people === "string") return problem(people);
        const updated = await data.updateGoal(found.id, {
          status: args.status,
          title: args.title,
          why: args.why,
          measure: args.measure,
          targetDate: args.target_date,
        });
        if (!updated) {
          return problem(`Only ${found.lead}, the team on it${found.leadId !== me.id ? `, or a parent for Gigi's goals` : ""} can change "${found.title}".`);
        }
        if (people.length) await data.addGoalPeople(found.id, people.map((m) => m.id));
        const fresh = people.length ? ((await data.updateGoal(found.id, {})) ?? updated) : updated;
        const cheer =
          args.status === "achieved"
            ? "\nAchieved. Celebrate it, and log what made it happen."
            : args.status === "let_go"
              ? "\nLet go, by choice. Worth logging what it taught."
              : "";
        return text(`Updated. ${goalLine(fresh)}${cheer}`);
      }),
  );

  server.registerTool(
    "list_goals",
    {
      title: "Dreams and goals",
      description: "Lists the family's dreams, goals and milestones, with who leads and who is on the team.",
      inputSchema: z.object({
        person: personField.describe("Only goals this person leads or is on. Leave out for everyone's."),
        include_closed: z.boolean().optional().describe("Also show achieved and let-go goals."),
      }),
      annotations: READ_ONLY,
    },
    async ({ person, include_closed }: { person?: string; include_closed?: boolean }, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        let goals = await data.goals({ includeClosed: include_closed ?? false });
        if (person) {
          const who = await memberOrProblem(data, me, person);
          if (typeof who === "string") return problem(who);
          goals = goals.filter((g) => g.leadId === who.id || g.teamIds.includes(who.id));
        }
        if (goals.length === 0) return text("No dreams or goals yet. Set one with set_goal.");
        return text(["Dreams and goals", ...goalTree(goals)].join("\n"));
      }),
  );

  server.registerTool(
    "catch_me_up",
    {
      title: "Catch me up",
      description:
        "The person's brief: their dreams and goals, this week's wins and learnings across the family, what they planned to try, and anything waiting for them. Use it at the start of a working session.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async (_args: Record<string, never>, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const day = today();
        const weekStart = weekStartOf(day);
        const [goals, entries, lastWeek, file, lists] = await Promise.all([
          data.goals(),
          data.entries({ from: weekStart, to: day }),
          data.reviews(addDays(weekStart, -7)),
          data.readFile(me.id),
          data.lists(),
        ]);
        const mine = goals.filter((g) => g.leadId === me.id || g.teamIds.includes(me.id));
        const lines = [`Catch-up for ${me.name}, ${formatDay(day, true)}`];
        lines.push("", "Your dreams and goals", ...(mine.length ? goalTree(mine) : ["None yet. Set one with set_goal."]));
        const celebrate = entries.filter((e) => e.kind === "win" || e.kind === "made");
        lines.push(
          "",
          "Wins and things made this week, across the family",
          ...(celebrate.length ? celebrate.map((e) => entryLine(e)) : ["None logged yet this week."]),
        );
        const tryNext = lastWeek.find((r) => r.memberId === me.id)?.nextTry;
        if (tryNext) lines.push("", `You planned to try this week: ${tryNext}`);
        const waiting = file?.preferences.filter((p) => p.status === "suggested").length ?? 0;
        if (waiting) lines.push("", `Waiting for you: ${waiting} suggestion${waiting === 1 ? "" : "s"} in your personal file to confirm.`);
        const shopping = lists.filter((l) => l.needed > 0);
        if (shopping.length) lines.push("", `Lists: ${shopping.map((l) => `${l.name} (${l.needed} to get)`).join(", ")}`);
        await data.log({ action: "brain.catch_up", subjectId: me.id });
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "week_in_review",
    {
      title: "The family week",
      description:
        "Gathers the week for the weekly review: what moved on each dream and goal, wins, learnings, gratitude, what was built, health, and who helped whom, plus how to write the review. It is never a scoreboard.",
      inputSchema: z.object({
        week_of: z.string().trim().max(20).optional().describe('Any day in the week: "today", "last week" or YYYY-MM-DD. Defaults to this week.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ week_of }: { week_of?: string }, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const now = today();
        const anchor = week_of?.trim().toLowerCase() === "last week" ? addDays(now, -7) : resolveDay(week_of, now);
        if (Array.isArray(anchor)) return problem(anchor[0]);
        const weekStart = weekStartOf(anchor);
        const [members, goals, entries, reviews, lastWeekReviews] = await Promise.all([
          data.members(),
          data.goals({ includeClosed: true }),
          data.entries({ from: weekStart, to: addDays(weekStart, 6) }),
          data.reviews(weekStart),
          data.reviews(addDays(weekStart, -7)),
        ]);
        await data.log({ action: "brain.week_in_review", subjectId: me.id, summary: `week of ${weekStart}` });
        return text(weekPack({ weekStart, today: now, me, members, goals, entries, reviews, lastWeekReviews }));
      }),
  );

  server.registerTool(
    "save_review",
    {
      title: "Save a weekly review",
      description:
        "Saves a person's weekly review once they are happy with it. Saving again for the same week replaces the earlier one and keeps it in the history.",
      inputSchema: z.object({
        review: z.string().trim().min(1).max(6000).describe("The review, as agreed with the person."),
        ai_skill: z.string().trim().max(500).optional().describe("One AI or building skill that grew this week."),
        next_try: z.string().trim().max(500).optional().describe("One thing to try next week."),
        person: personField,
        week_of: z.string().trim().max(20).optional().describe("Any day in the week. Defaults to this week."),
      }),
      annotations: WRITES,
    },
    async (
      args: { review: string; ai_skill?: string; next_try?: string; person?: string; week_of?: string },
      ctx: ToolContext,
    ) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const owner = await memberOrProblem(data, me, args.person);
        if (typeof owner === "string") return problem(owner);
        if (!canWriteFile(me, owner)) return problem(`${owner.name}'s review is ${owner.name}'s to save.`);
        const now = today();
        const anchor = args.week_of?.trim().toLowerCase() === "last week" ? addDays(now, -7) : resolveDay(args.week_of, now);
        if (Array.isArray(anchor)) return problem(anchor[0]);
        const saved = await data.saveReview({
          weekStart: weekStartOf(anchor),
          memberId: owner.id,
          addedBy: me.id,
          body: args.review,
          aiSkill: args.ai_skill || null,
          nextTry: args.next_try || null,
        });
        return text(
          `Saved ${owner.id === me.id ? "your" : `${owner.name}'s`} review for the week of ${formatDay(saved.weekStart, true)}.` +
            `${saved.aiSkill ? `\nAI skill grown: ${saved.aiSkill}` : ""}${saved.nextTry ? `\nTo try next week: ${saved.nextTry}` : ""}`,
        );
      }),
  );

  server.registerTool(
    "withdraw_entry",
    {
      title: "Withdraw a journal entry",
      description: "Takes back a journal entry logged by mistake. It is hidden from the family, never rewritten.",
      inputSchema: z.object({ id: z.string().trim().regex(UUID, "Use the id shown when it was logged.") }),
      annotations: WRITES,
    },
    async ({ id }: { id: string }, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const ok = await caller.data.withdrawEntry(id);
        return ok ? text("Withdrawn.") : problem("No entry with that id that you are allowed to withdraw.");
      }),
  );
}

export type { Review };
