import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/config";

const noSession = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

// A Supabase client acting as the person a bearer token belongs to.
// Every query it makes runs under that person's row level security.
export function createTokenClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// Used only to verify tokens against the project's public signing keys.
// Kept at module level so the key set is cached between requests.
let verifier: SupabaseClient | undefined;
export function tokenVerifier(): SupabaseClient {
  verifier ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: noSession });
  return verifier;
}
