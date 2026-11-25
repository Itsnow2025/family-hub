import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { CONNECTOR_PATH } from "@/lib/config";
import { BRAIN_INSTRUCTIONS, registerBrainTools } from "./brain-tools";
import { registerListTools } from "./list-tools";
import { registerHubTools, SERVER_INSTRUCTIONS, type DataForAuth } from "./tools";

export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${CONNECTOR_PATH}`;

// The connector as a web-standard handler. Token checking and data access are
// passed in, so tests can run the full MCP exchange without a database.
export function createHubHandler(deps: {
  verify: (token: string | undefined) => Promise<AuthInfo | undefined>;
  dataFor: DataForAuth;
  today?: () => string;
}): (req: Request) => Promise<Response> {
  const mcp = createMcpHandler(
    (server) => {
      registerHubTools(server, deps.dataFor);
      registerListTools(server, deps.dataFor);
      registerBrainTools(server, deps.dataFor, deps.today);
    },
    {
      serverInfo: { name: "family-hub", version: "0.3.0" },
      instructions: `${SERVER_INSTRUCTIONS}\n\n${BRAIN_INSTRUCTIONS}`,
    },
  );
  return withMcpAuth(mcp, (_req, bearerToken) => deps.verify(bearerToken), {
    required: true,
    resourceMetadataPath: RESOURCE_METADATA_PATH,
  });
}
