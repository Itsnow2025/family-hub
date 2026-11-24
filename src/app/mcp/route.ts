import { verifyAccessToken } from "@/lib/hub/auth";
import { createHubHandler } from "@/lib/hub/server";
import { supabaseHubData } from "@/lib/hub/supabase-data";
import { createTokenClient, tokenVerifier } from "@/lib/supabase/token";

export const dynamic = "force-dynamic";

const handler = createHubHandler({
  verify: (token) => verifyAccessToken(tokenVerifier(), token),
  // Every tool call runs as the person whose token it is, so the database's
  // rules decide what they can see and change, not this code.
  dataFor: (authInfo) => (authInfo ? supabaseHubData(createTokenClient(authInfo.token)) : undefined),
});

export { handler as GET, handler as POST, handler as DELETE };
