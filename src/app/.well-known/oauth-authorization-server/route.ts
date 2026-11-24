import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { SUPABASE_URL } from "@/lib/config";
import { METADATA_CORS } from "@/lib/hub/metadata";

export const dynamic = "force-dynamic";

// For older AI apps that look for sign-in details on the connector's own
// domain instead of following the protected resource metadata. It passes on
// the real sign-in server's metadata unchanged.
export async function GET() {
  const upstream = await fetch(`${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`, {
    cache: "no-store",
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...METADATA_CORS,
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": upstream.ok ? "public, max-age=300" : "no-store",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
