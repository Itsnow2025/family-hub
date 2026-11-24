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
      "confirm_preference",
      "read_personal_file",
      "remember_preference",
      "retire_preference",
      "show_list",
      "suggest_preference",
      "tick_off_list",
      "update_about",
      "who_am_i",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["read_personal_file", "show_list", "who_am_i"]);
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
