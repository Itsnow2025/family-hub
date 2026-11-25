import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createHubHandler } from "@/lib/hub/server";
import type { Member } from "@/lib/hub/types";
import { FakeFamily, FERIQUE, GIGI, PHIL } from "./fake-hub";

const TOKENS: Record<string, Member> = { "phil-token": PHIL, "ferique-token": FERIQUE, "gigi-token": GIGI };
const URL_ = "https://family-hub.test/mcp";

let family: FakeFamily;
let handler: (req: Request) => Promise<Response>;

beforeEach(() => {
  family = new FakeFamily();
  handler = createHubHandler({
    verify: async (token) =>
      token && TOKENS[token] ? { token, clientId: "grok-client", scopes: [], extra: { userId: TOKENS[token].id } } : undefined,
    dataFor: (auth) => (auth ? family.viewFor(TOKENS[auth.token]) : undefined),
    today: () => "2026-11-26",
  });
});

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => handler(new Request(input, init)),
  });
  const client = new Client({ name: "test-grok", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

describe("signing in", () => {
  it("refuses a request without a token and points the AI app to the sign-in details", async () => {
    const res = await handler(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('resource_metadata="https://family-hub.test/.well-known/oauth-protected-resource/mcp"');
  });

  it("refuses a token it cannot verify", async () => {
    await expect(connect("made-up-token")).rejects.toThrow();
  });
});

describe("tools", () => {
  it("lists the personal file tools", async () => {
    const client = await connect("phil-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_to_list",
      "catch_me_up",
      "confirm_preference",
      "list_goals",
      "log_entry",
      "read_personal_file",
      "remember_preference",
      "retire_preference",
      "save_review",
      "set_goal",
      "show_list",
      "suggest_preference",
      "tick_off_list",
      "update_about",
      "update_goal",
      "week_in_review",
      "who_am_i",
      "withdraw_entry",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["catch_me_up", "list_goals", "read_personal_file", "show_list", "week_in_review", "who_am_i"]);
  });

  it("says who is connected, and logs it", async () => {
    const client = await connect("gigi-token");
    const { text } = await call(client, "who_am_i");
    expect(text).toContain("connected to Family Hub as Gigi (child)");
    expect(text).toContain("write in your own file");
    expect(family.log).toContainEqual({ actor: "Gigi", action: "connector.who_am_i", subjectId: GIGI.id });
  });

  it("tells a parent they can also write in Gigi's file", async () => {
    const { text } = await call(await connect("phil-token"), "who_am_i");
    expect(text).toContain("your own file and Gigi's");
  });

  it("remembers a preference word for word and reads it back", async () => {
    const client = await connect("phil-token");
    const saved = await call(client, "remember_preference", {
      category: " Work ",
      preference: "I prefer meetings before 11am.",
    });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain('"I prefer meetings before 11am."');
    expect(saved.text).toContain("Category: work");
    expect(family.preferences[0]).toMatchObject({ status: "confirmed", source: "self", visibility: "family" });

    const file = await call(client, "read_personal_file", {});
    expect(file.text).toContain("Phil's file (yours)");
    expect(file.text).toContain("[work] I prefer meetings before 11am.");
    expect(family.log.at(-1)).toMatchObject({ action: "file.read", subjectId: PHIL.id });
  });

  it("keeps a suggestion out of the file until the owner confirms it", async () => {
    const phil = await connect("phil-token");
    const suggested = await call(phil, "suggest_preference", { category: "food", preference: "Likes strong coffee" });
    expect(suggested.text).toContain("stays a suggestion until you confirm");
    const id = family.preferences[0].id;

    const ferique = await connect("ferique-token");
    expect((await call(ferique, "read_personal_file", { person: "phil" })).text).not.toContain("strong coffee");

    expect((await call(phil, "confirm_preference", { id })).text).toContain("Confirmed");
    expect((await call(ferique, "read_personal_file", { person: "Phil" })).text).toContain("Likes strong coffee");
  });

  it("does not let Gigi write in a parent's file", async () => {
    const gigi = await connect("gigi-token");
    const result = await call(gigi, "remember_preference", { category: "food", preference: "x", person: "Phil" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Phil's file is Phil's to write in");
    expect(family.preferences).toHaveLength(0);
  });

  it("lets a parent write in Gigi's file, but never as private", async () => {
    const phil = await connect("phil-token");
    const ok = await call(phil, "remember_preference", { category: "school", preference: "Maths on Tuesdays", person: "gigi" });
    expect(ok.isError).toBe(false);
    expect(family.preferences[0]).toMatchObject({ memberId: GIGI.id, source: "parent" });

    const refused = await call(phil, "remember_preference", {
      category: "school",
      preference: "secret",
      person: "Gigi",
      visibility: "private",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no private entries");
  });

  it("hides parents-only entries from Gigi", async () => {
    const phil = await connect("phil-token");
    await call(phil, "remember_preference", { category: "gifts", preference: "Birthday surprise plan", visibility: "parents" });
    await call(phil, "remember_preference", { category: "food", preference: "Loves pasta" });
    const seenByGigi = (await call(await connect("gigi-token"), "read_personal_file", { person: "Phil" })).text;
    expect(seenByGigi).toContain("Loves pasta");
    expect(seenByGigi).not.toContain("Birthday surprise");
    const seenByFerique = (await call(await connect("ferique-token"), "read_personal_file", { person: "Phil" })).text;
    expect(seenByFerique).toContain("Birthday surprise");
  });

  it("retires instead of deleting", async () => {
    const phil = await connect("phil-token");
    await call(phil, "remember_preference", { category: "food", preference: "No dairy" });
    const id = family.preferences[0].id;
    expect((await call(phil, "retire_preference", { id })).text).toContain("stays in the file's history");
    expect((await call(phil, "read_personal_file", {})).text).not.toContain("No dairy");
    expect((await call(phil, "read_personal_file", { include_retired: true })).text).toContain("No dairy");
  });

  it("will not change an entry the caller does not own", async () => {
    await call(await connect("phil-token"), "remember_preference", { category: "food", preference: "No dairy" });
    const id = family.preferences[0].id;
    const result = await call(await connect("gigi-token"), "retire_preference", { id });
    expect(result.isError).toBe(true);
    expect(family.preferences[0].status).toBe("confirmed");
  });

  it("names the family when a person is not found", async () => {
    const result = await call(await connect("phil-token"), "read_personal_file", { person: "Peter" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Phil, Ferique and Gigi");
  });

  it("explains when this AI has been switched off", async () => {
    family.aiStatus.set(GIGI.id, "switched_off");
    const result = await call(await connect("gigi-token"), "read_personal_file", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("switched off for Gigi");
  });

  it("explains when all AI access is off", async () => {
    family.aiStatus.set(GIGI.id, "ai_access_off");
    const result = await call(await connect("gigi-token"), "who_am_i");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("A parent can switch it back on");
  });

  it("updates the About note only for files the caller may write in", async () => {
    const phil = await connect("phil-token");
    expect((await call(phil, "update_about", { about: "Founder. Early riser." })).text).toContain("Founder. Early riser.");
    const refused = await call(await connect("gigi-token"), "update_about", { about: "x", person: "Phil" });
    expect(refused.isError).toBe(true);
    expect(family.about.get(PHIL.id)).toBe("Founder. Early riser.");
  });
});

describe("shared lists", () => {
  it("lets Ferique add to Shopping and everyone see it", async () => {
    const ferique = await connect("ferique-token");
    const added = await call(ferique, "add_to_list", { items: ["Milk", "eggs", "horse feed"] });
    expect(added.text).toContain("Added to Shopping: Milk, eggs, horse feed.");
    expect(added.text).toContain("Shopping now has 3 to get.");

    const seenByGigi = await call(await connect("gigi-token"), "show_list", {});
    expect(seenByGigi.text).toContain("Shopping, 3 to get:");
    expect(seenByGigi.text).toContain("- Milk (Ferique)");
  });

  it("does not add the same thing twice", async () => {
    const ferique = await connect("ferique-token");
    await call(ferique, "add_to_list", { items: ["Milk"] });
    const again = await call(await connect("phil-token"), "add_to_list", { items: ["milk", "bread"], list: "the shopping list" });
    expect(again.text).toContain("Added to Shopping: bread.");
    expect(again.text).toContain("Already on it: milk.");
    expect(family.items).toHaveLength(2);
  });

  it("ticks things off by a loose name, and reports what it could not find", async () => {
    const phil = await connect("phil-token");
    await call(phil, "add_to_list", { items: ["2 litres of milk", "eggs"] });
    const ticked = await call(phil, "tick_off_list", { items: ["milk", "caviar"] });
    expect(ticked.text).toContain("Ticked off Shopping: 2 litres of milk.");
    expect(ticked.text).toContain("Could not find on Shopping: caviar.");
    expect(ticked.text).toContain("Still to get: 1.");
    expect(family.items.find((i) => i.item === "2 litres of milk")).toMatchObject({ status: "got", doneBy: "Phil" });
  });

  it("puts back something ticked off by mistake, and removes without deleting", async () => {
    const phil = await connect("phil-token");
    await call(phil, "add_to_list", { items: ["eggs", "bread"] });
    await call(phil, "tick_off_list", { items: ["eggs"] });
    expect((await call(phil, "tick_off_list", { items: ["eggs"], action: "put_back" })).text).toContain("Put back on Shopping: eggs.");
    await call(phil, "tick_off_list", { items: ["bread"], action: "remove" });
    expect(family.items.map((i) => `${i.item}:${i.status}`).sort()).toEqual(["bread:removed", "eggs:needed"]);
  });

  it("starts a new family list when one is named that does not exist", async () => {
    const gigi = await connect("gigi-token");
    const added = await call(gigi, "add_to_list", { items: ["hoof pick"], list: "Feed store" });
    expect(added.text).toContain("Started a new list called Feed store");
    const shown = await call(await connect("ferique-token"), "show_list", {});
    expect(shown.text).toContain("Other lists: Feed store (1)");
  });

  it("says which lists exist when asked for one that does not", async () => {
    const result = await call(await connect("phil-token"), "show_list", { list: "Christmas" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("The lists are: Shopping.");
  });
});

describe("the family brain", () => {
  it("tells every AI the family's way of working", async () => {
    const client = await connect("phil-token");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Celebrate every win, however small");
    expect(instructions).toContain("There is no failure, only learnings");
    expect(instructions).toContain("Remember gratitude");
    expect(instructions).toContain("Never count, rank or compare people");
    expect(instructions).toContain("Shall I log that to the Brain?");
  });

  it("sets a dream with a goal under it, led by Gigi with her parents on the team", async () => {
    const phil = await connect("phil-token");
    const dream = await call(phil, "set_goal", { title: "Win the Tamworth Futurity", kind: "dream", lead: "Gigi", team: ["Phil", "Ferique"], target_date: "2027-05-27" });
    expect(dream.isError).toBe(false);
    expect(dream.text).toContain("Dream: Win the Tamworth Futurity, by 27 May 2027 (Gigi leads; with Phil and Ferique)");
    const goal = await call(phil, "set_goal", { title: "Ride five days a week", lead: "Gigi", part_of: "tamworth futurity" });
    expect(goal.text).toContain("Goal: Ride five days a week");
    expect(family.goals[1].parentId).toBe(family.goals[0].id);

    const list = await call(await connect("ferique-token"), "list_goals", {});
    expect(list.text).toContain("- Dream: Win the Tamworth Futurity");
    expect(list.text).toContain("  - Goal: Ride five days a week");
  });

  it("will not let Gigi set a goal in a parent's name", async () => {
    const result = await call(await connect("gigi-token"), "set_goal", { title: "x", lead: "Phil" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Only Phil can set a goal that Phil leads");
  });

  it("celebrates a small win, linked to its goal", async () => {
    const gigi = await connect("gigi-token");
    await call(gigi, "set_goal", { title: "Ride five days a week" });
    const win = await call(gigi, "log_entry", { kind: "win", what: "Rode Flicker four days in a row", goal: "ride five days" });
    expect(win.text).toContain('Logged to your journal for Thu 26 Nov: win, "Rode Flicker four days in a row"');
    expect(win.text).toContain("Part of: Ride five days a week");
    expect(win.text).toContain("worth celebrating");
  });

  it("records a learning, and has no kind for failure", async () => {
    const phil = await connect("phil-token");
    const learning = await call(phil, "log_entry", { kind: "learning", what: "Cold email without a warm intro got no replies; ask for intros first", when: "yesterday" });
    expect(learning.text).toContain("for Wed 25 Nov: learning");
    const failure = await call(phil, "log_entry", { kind: "failure", what: "x" });
    expect(failure.isError).toBe(true);
  });

  it("logs gratitude to a named person, and shows who helped whom in the week", async () => {
    const ferique = await connect("ferique-token");
    await call(ferique, "log_entry", { kind: "gratitude", what: "Phil cooked dinner three nights so I could finish the build budget", thanks_to: "Phil" });
    const week = await call(ferique, "week_in_review", {});
    expect(week.text).toContain("Gratitude");
    expect(week.text).toContain("Ferique thanked Phil");
  });

  it("keeps health entries to the person and the parents by default", async () => {
    const gigi = await connect("gigi-token");
    await call(gigi, "log_entry", { kind: "health", what: "Sore wrist after the fall at training" });
    expect(family.entries[0].visibility).toBe("parents");
    const phil = await connect("phil-token");
    await call(phil, "log_entry", { kind: "health", what: "Migraine on Tuesday" });
    expect((await call(gigi, "week_in_review", {})).text).not.toContain("Migraine");
    expect((await call(await connect("ferique-token"), "week_in_review", {})).text).toContain("Migraine");
  });

  it("logs something made with AI, naming the tool", async () => {
    const gigi = await connect("gigi-token");
    const made = await call(gigi, "log_entry", { kind: "made", what: "Built a stallion comparison table for Inky", tool: "Grok" });
    expect(made.text).toContain("Made with: Grok");
    expect((await call(gigi, "week_in_review", {})).text).toContain("Built and created this week");
  });

  it("will not let Gigi write in a parent's journal", async () => {
    const result = await call(await connect("gigi-token"), "log_entry", { kind: "win", what: "x", person: "Ferique" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Ferique's journal is Ferique's to write in");
  });

  it("builds the week by dream and goal, with the review guidance and no scoreboard", async () => {
    const phil = await connect("phil-token");
    await call(phil, "set_goal", { title: "One $10k Kula client a month", target_date: "2027-03-31" });
    await call(phil, "set_goal", { title: "Sell the Willow Vale house" });
    await call(phil, "log_entry", { kind: "win", what: "First call booked with a Byron studio", goal: "kula client" });
    const week = await call(phil, "week_in_review", {});
    expect(week.text).toContain("Family week: Mon 23 Nov to Sun 29 Nov 2026");
    expect(week.text).toContain("* Goal: One $10k Kula client a month, by 31 March 2027 (Phil leads)");
    expect(week.text).toContain("  - Win (Phil, Thu 26 Nov): First call booked with a Byron studio");
    expect(week.text).toContain("* Goal: Sell the Willow Vale house (Phil leads)\n  No news this week.");
    expect(week.text).toContain("Start with the wins, every one, however small.");
    expect(week.text).toContain("Never call it a failure.");
    expect(week.text).toContain("For Ferique and Gigi: name one AI or building skill that grew this week");
    expect(week.text).not.toMatch(/leaderboard|most entries|points|\d+ (entries|wins) (by|for)/i);
  });

  it("saves a review, replaces it when run again, and carries 'try next' into the next week", async () => {
    const gigi = await connect("gigi-token");
    await call(gigi, "save_review", { review: "First draft", week_of: "2026-11-19" });
    const saved = await call(gigi, "save_review", {
      review: "A big week with Flicker.",
      ai_skill: "Asked Grok to compare two stallions side by side",
      next_try: "Use Grok to plan the week's rides",
      week_of: "2026-11-19",
    });
    expect(saved.text).toContain("Saved your review for the week of Mon 16 Nov 2026");
    expect(family.reviews.filter((r) => !r.superseded)).toHaveLength(1);
    const catchUp = await call(gigi, "catch_me_up", {});
    expect(catchUp.text).toContain("You planned to try this week: Use Grok to plan the week's rides");
    const week = await call(await connect("phil-token"), "week_in_review", {});
    expect(week.text).toContain("Things to try, from last week's reviews\n- Gigi: Use Grok to plan the week's rides");
  });

  it("marks a goal achieved and celebrates it; letting go is a choice, not a failure", async () => {
    const phil = await connect("phil-token");
    await call(phil, "set_goal", { title: "Sell Roscoe for $10k" });
    const done = await call(phil, "update_goal", { goal: "roscoe", status: "achieved" });
    expect(done.text).toContain("[achieved]");
    expect(done.text).toContain("Celebrate it");
    await call(phil, "set_goal", { title: "Sell Paige for $10k" });
    const letGo = await call(phil, "update_goal", { goal: "paige", status: "let_go" });
    expect(letGo.text).toContain("Let go, by choice. Worth logging what it taught.");
  });

  it("will not let Gigi change a parent's goal she is not part of", async () => {
    await call(await connect("phil-token"), "set_goal", { title: "Kula $100K MRR by June 2027" });
    const result = await call(await connect("gigi-token"), "update_goal", { goal: "kula", status: "achieved" });
    expect(result.isError).toBe(true);
    expect(family.goals[0].status).toBe("active");
  });

  it("asks which goal when more than one matches", async () => {
    const phil = await connect("phil-token");
    await call(phil, "set_goal", { title: "Sell Roscoe" });
    await call(phil, "set_goal", { title: "Sell Paige" });
    const result = await call(phil, "log_entry", { kind: "win", what: "x", goal: "sell" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("More than one goal matches");
  });

  it("refuses a day in the future", async () => {
    const result = await call(await connect("phil-token"), "log_entry", { kind: "win", what: "x", when: "2027-01-01" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("in the future");
  });
});
