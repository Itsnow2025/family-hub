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
      "confirm_preference",
      "read_personal_file",
      "remember_preference",
      "retire_preference",
      "suggest_preference",
      "update_about",
      "who_am_i",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["read_personal_file", "who_am_i"]);
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
