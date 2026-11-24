import type { AuthInfo } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_ISSUER } from "@/lib/config";

// Accepts only access tokens that Family Hub's own sign-in issued to an AI
// app: signed by the project's keys, from our issuer, unexpired, for a
// signed-in person, and carrying the client_id of the app that obtained it.
// A plain app session token has no client_id and is refused here.
export async function verifyAccessToken(
  verifier: SupabaseClient,
  token: string | undefined,
  now: () => number = Date.now,
): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const { data, error } = await verifier.auth.getClaims(token);
  if (error || !data?.claims) return undefined;
  const claims = data.claims;
  if (claims.iss !== AUTH_ISSUER) return undefined;
  if (claims.role !== "authenticated" || typeof claims.sub !== "string") return undefined;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return undefined;
  const clientId = claims.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return undefined;
  return {
    token,
    clientId,
    scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
    expiresAt: claims.exp,
    extra: { userId: claims.sub },
  };
}
