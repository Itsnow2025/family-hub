import { generateProtectedResourceMetadata, getPublicOrigin } from "mcp-handler";
import { AUTH_ISSUER, CONNECTOR_PATH } from "@/lib/config";

export const METADATA_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// RFC 9728: tells an AI app which sign-in server protects the connector.
export function protectedResourceResponse(req: Request): Response {
  const origin = getPublicOrigin(req);
  const body = generateProtectedResourceMetadata({
    authServerUrls: [AUTH_ISSUER],
    resourceUrl: `${origin}${CONNECTOR_PATH}`,
    additionalMetadata: { resource_name: "Family Hub" },
  });
  return Response.json(body, {
    headers: { ...METADATA_CORS, "Cache-Control": "public, max-age=300" },
  });
}
