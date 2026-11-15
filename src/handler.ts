import {
  createMcpHandler,
  localhostAllowedHostnames,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { createServer } from "./tools";

/**
 * Clusterflick's listings for AI assistants, as a remote MCP server: a reader
 * asks their own assistant what's on, and it searches here. Read-only, over
 * the listings the site publishes.
 */

export const MCP_PATH = "/mcp";

/** Stateless: a fresh server for each request, so nothing is shared between readers. */
const mcp = createMcpHandler(() => createServer(env.SITE_ORIGIN));

export async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== MCP_PATH) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Assistants call from their own servers, with no Origin. A browser page
  // can only be a local tool, such as the MCP Inspector; any other site's
  // page is refused, so it can't use a reader's sign-in from their browser.
  const refused = originValidationResponse(
    request,
    localhostAllowedHostnames(),
  );
  return refused ?? mcp.fetch(request);
}
