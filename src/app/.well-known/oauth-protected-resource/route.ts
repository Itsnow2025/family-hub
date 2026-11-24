import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { protectedResourceResponse } from "@/lib/hub/metadata";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => protectedResourceResponse(req);
export const OPTIONS = metadataCorsOptionsRequestHandler();
