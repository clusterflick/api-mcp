import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import {
  createMcpHandler,
  localhostAllowedHostnames,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import type { Props } from "./authorize";
import { hasAssistantAccess } from "./capability";
import { UpstreamError } from "./google-auth";
import { readReaderLists } from "./reader-lists";
import { LISTS } from "./scopes";
import { createServer } from "./tools";

/**
 * Clusterflick's listings for AI assistants, as a remote MCP server: a reader
 * asks their own assistant what's on, and it searches here. Read-only, over
 * the listings the site publishes.
 *
 * Only reached with a valid access token: the OAuth library in front
 * (`index.ts`) answers anything else with the challenge that sends an
 * assistant to sign the reader in. `ctx.props` is who they signed in as.
 */

export const MCP_PATH = "/mcp";

/**
 * Stateless: a fresh server for each request, built for the reader making
 * it, so nothing is shared between readers.
 */
const mcp = createMcpHandler(({ authInfo }) => {
  const uid = String(authInfo?.extra?.uid ?? "");
  return createServer(env.SITE_ORIGIN, {
    uid,
    // Only a connection the reader gave their lists to reads them.
    canSeeLists: authInfo?.scopes.includes(LISTS) ?? false,
    readLists: () => readReaderLists(env, uid),
  });
});

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

export async function handleMcp(
  request: Request,
  workerEnv: Env,
  ctx: OAuthResourceContext<Props>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== MCP_PATH) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Assistants call from their own servers, with no Origin. A browser page
  // can only be a local tool, such as the MCP Inspector; any other site's
  // page is refused.
  const refused = originValidationResponse(
    request,
    localhostAllowedHostnames(),
  );
  if (refused) return refused;

  const { uid } = ctx.props;
  // Per reader, not per IP: every call is tied to an account.
  const { success } = await workerEnv.CALL_LIMIT.limit({ key: uid });
  if (!success) {
    console.log(JSON.stringify({ event: "mcp-call", uid, outcome: "limited" }));
    return json(
      429,
      {
        error: "rate_limited",
        error_description: "Too many searches. Try again in a minute.",
      },
      { "Retry-After": "60" },
    );
  }

  let granted: boolean;
  try {
    granted = await hasAssistantAccess(workerEnv, uid);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.error(
      JSON.stringify({
        event: "mcp-call",
        uid,
        outcome: "unavailable",
        message: error.message,
      }),
    );
    return json(503, {
      error: "temporarily_unavailable",
      error_description:
        "Clusterflick couldn't check your access just now. Try again in a minute.",
    });
  }
  if (!granted) {
    console.log(
      JSON.stringify({ event: "mcp-call", uid, outcome: "not-permitted" }),
    );
    return json(403, {
      error: "access_denied",
      error_description:
        "This Clusterflick account no longer has AI assistant access.",
    });
  }

  return mcp.fetch(request, {
    authInfo: {
      token: ctx.auth.token,
      clientId: ctx.auth.clientId ?? "",
      scopes: ctx.auth.scope,
      extra: { uid },
    },
  });
}
