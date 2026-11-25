import { describe, expect, it } from "vitest";
import { AUTH_ISSUER } from "@/lib/config";
import { verifyAccessToken } from "@/lib/hub/auth";
import { blockedByParent, displayNameForClient, doorForClient, type ConnectedAiRow } from "@/lib/hub/connected-ais";
import { findList, matchItems } from "@/lib/hub/list-tools";
import { addDays, weekStartOf, todayIn } from "@/lib/hub/week";
import type { ListItem } from "@/lib/hub/types";
import { formatFile, resolvePerson } from "@/lib/hub/tools";
import { FAMILY, FERIQUE, GIGI, PHIL } from "./fake-hub";
import type { SupabaseClient } from "@supabase/supabase-js";

const NOW = 1_800_000_000_000;

function verifierReturning(claims: Record<string, unknown> | null): SupabaseClient {
  return {
    auth: {
      getClaims: async () =>
        claims ? { data: { claims, header: {}, signature: new Uint8Array() }, error: null } : { data: null, error: new Error("bad") },
    },
  } as unknown as SupabaseClient;
}

const good = {
  iss: AUTH_ISSUER,
  sub: PHIL.id,
  role: "authenticated",
  exp: NOW / 1000 + 600,
  client_id: "grok-client",
  scope: "openid email",
};

describe("token check", () => {
  it("accepts a token issued to an AI app", async () => {
    const info = await verifyAccessToken(verifierReturning(good), "t", () => NOW);
    expect(info).toMatchObject({ token: "t", clientId: "grok-client", scopes: ["openid", "email"], extra: { userId: PHIL.id } });
  });
  it("refuses an app session token, which has no client_id", async () => {
    const session: Record<string, unknown> = { ...good };
    delete session.client_id;
    expect(await verifyAccessToken(verifierReturning(session), "t", () => NOW)).toBeUndefined();
  });
  it("refuses another issuer, an expired token, a bad signature, or no token", async () => {
    expect(await verifyAccessToken(verifierReturning({ ...good, iss: "https://elsewhere/auth/v1" }), "t", () => NOW)).toBeUndefined();
    expect(await verifyAccessToken(verifierReturning({ ...good, exp: NOW / 1000 - 1 }), "t", () => NOW)).toBeUndefined();
    expect(await verifyAccessToken(verifierReturning({ ...good, role: "anon" }), "t", () => NOW)).toBeUndefined();
    expect(await verifyAccessToken(verifierReturning(null), "t", () => NOW)).toBeUndefined();
    expect(await verifyAccessToken(verifierReturning(good), undefined, () => NOW)).toBeUndefined();
  });
});

describe("people and doors", () => {
  it("resolves names loosely and 'me' to the caller", () => {
    expect(resolvePerson(FAMILY, PHIL, undefined)).toBe(PHIL);
    expect(resolvePerson(FAMILY, PHIL, "Me")).toBe(PHIL);
    expect(resolvePerson(FAMILY, PHIL, "gigi")).toBe(GIGI);
    expect(resolvePerson(FAMILY, PHIL, "Fer")).toBe(FERIQUE);
    expect(resolvePerson(FAMILY, PHIL, "Peter")).toContain("no family member");
  });
  it("names the door from the AI app's name", () => {
    expect(doorForClient("Grok")).toBe("grok");
    expect(doorForClient("xAI Grok")).toBe("grok");
    expect(doorForClient("Claude")).toBe("claude");
    expect(doorForClient("ChatGPT")).toBe("other_ai");
  });
  it("shows Grok Bot by its own name even though it calls itself Cursor", () => {
    expect(doorForClient("Cursor")).toBe("grok");
    expect(displayNameForClient("Cursor", "grok")).toBe("Grok Bot");
    expect(displayNameForClient("Cursor", "other_ai")).toBe("Cursor");
    expect(displayNameForClient("", "claude")).toBe("Claude");
  });
  it("matches spoken list names and items loosely but never ambiguously", () => {
    const lists = [
      { id: "1", name: "Shopping", visibility: "family" as const, ownerId: "x", needed: 0 },
      { id: "2", name: "Feed store", visibility: "family" as const, ownerId: "x", needed: 0 },
    ];
    expect(findList(lists, undefined)?.name).toBe("Shopping");
    expect(findList(lists, "the feed store list")?.name).toBe("Feed store");
    expect(findList(lists, "Christmas")).toBeUndefined();
    const items = ["full cream milk", "almond milk", "eggs"].map((item, n) => ({ id: String(n), item }) as ListItem);
    expect(matchItems(items, ["eggs"]).matched.map((i) => i.item)).toEqual(["eggs"]);
    expect(matchItems(items, ["milk"]).missing).toEqual(["milk"]);
    expect(matchItems(items, ["almond milk"]).matched.map((i) => i.item)).toEqual(["almond milk"]);
  });
  it("stops Gigi reconnecting an AI a parent switched off, but not one she switched off", () => {
    const row = { enabled: false, changed_by: PHIL.id } as ConnectedAiRow;
    expect(blockedByParent(row, GIGI, FAMILY)).toBe(true);
    expect(blockedByParent({ ...row, changed_by: GIGI.id }, GIGI, FAMILY)).toBe(false);
    expect(blockedByParent({ ...row, enabled: true }, GIGI, FAMILY)).toBe(false);
    expect(blockedByParent(row, FERIQUE, FAMILY)).toBe(false);
  });
  it("describes an empty file kindly", () => {
    expect(formatFile({ member: PHIL, about: null, preferences: [] }, PHIL)).toContain("Your file has no preferences yet.");
    expect(formatFile({ member: PHIL, about: null, preferences: [] }, GIGI)).toContain("Nothing in Phil's file is shared with you yet.");
  });
});

describe("family weeks", () => {
  it("starts every week on Monday", () => {
    expect(weekStartOf("2026-11-23")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-26")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-29")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-30")).toBe("2026-11-30");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
  it("knows today in Sydney, not on the server's clock", () => {
    // 2pm UTC on 24 Nov is 1am on 25 Nov in Sydney (daylight saving).
    expect(todayIn("Australia/Sydney", new Date("2026-11-24T14:00:00Z"))).toBe("2026-11-25");
  });
});
