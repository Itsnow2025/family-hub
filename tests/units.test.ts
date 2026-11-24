import { describe, expect, it } from "vitest";
import { AUTH_ISSUER } from "@/lib/config";
import { verifyAccessToken } from "@/lib/hub/auth";
import { blockedByParent, doorForClient, type ConnectedAiRow } from "@/lib/hub/connected-ais";
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
