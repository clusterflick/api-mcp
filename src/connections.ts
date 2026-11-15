import {
  CimdFetchError,
  type GrantSummary,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { JWTVerifyGetKey } from "jose";
import { AuthError, getBearerToken, verifyFirebaseToken } from "./auth";

/**
 * A reader's connected assistants, for /personalise to list and disconnect:
 * each connection is an OAuth grant, which the library keeps per reader.
 *
 * - `GET /connections`: their connections, newest first.
 * - `DELETE /connections/<id>`: disconnect one. Its tokens go with it, so
 *   the assistant's next call is refused, and it would have to sign in
 *   again.
 *
 * Signed in with a Firebase ID token, as api-profiles' purge is, and called
 * from the site's pages, so it answers the site's origin (CORS). Not behind
 * the capability: a reader whose access was revoked can still see what's
 * connected, and remove it.
 */

export const CONNECTIONS_PATH = "/connections";

export type Connection = {
  id: string;
  /** What the assistant calls itself; for one with a metadata document, its domain. */
  name: string;
  /** For a Client ID Metadata Document client: the domain it's published on. */
  domain?: string;
  /** Epoch milliseconds. */
  connectedAt: number;
  /**
   * What the reader allowed it, as scopes (`src/scopes.ts`), for the panel
   * to say what it can and can't do: one connected before a scope existed,
   * or with it unticked, doesn't have it.
   */
  scopes: string[];
};

/** The id a grant is stored under: what the library makes, nothing else. */
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The client's name, as its registration or metadata document gives it,
 * verified only for a metadata document, whose domain is shown beside it.
 */
async function describe(
  oauth: OAuthHelpers,
  grant: GrantSummary,
): Promise<Connection> {
  const cimd = grant.clientId.startsWith("https://");
  const domain = cimd ? new URL(grant.clientId).hostname : undefined;
  let name: string | undefined;
  try {
    name = (await oauth.lookupClient(grant.clientId))?.clientName;
  } catch (error) {
    // A metadata document that can't be fetched just now still has a domain.
    if (!(error instanceof CimdFetchError)) throw error;
  }
  return {
    id: grant.id,
    name: name || domain || "An assistant",
    ...(domain ? { domain } : {}),
    connectedAt: grant.createdAt * 1000,
    scopes: grant.scope,
  };
}

async function list(oauth: OAuthHelpers, uid: string) {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(uid, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const connections = await Promise.all(grants.map((g) => describe(oauth, g)));
  return connections.sort((a, b) => b.connectedAt - a.connectedAt);
}

/** The site's origin, the only one whose pages may call these. */
const siteOrigin = (env: Env) => new URL(env.CONNECT_URL).origin;

function cors(env: Env, request: Request): Record<string, string> {
  return request.headers.get("Origin") === siteOrigin(env)
    ? {
        "Access-Control-Allow-Origin": siteOrigin(env),
        "Access-Control-Allow-Methods": "GET, DELETE",
        "Access-Control-Allow-Headers": "Authorization",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

export async function handleConnections(
  request: Request,
  env: Env & { OAUTH_PROVIDER: OAuthHelpers },
  keys: JWTVerifyGetKey,
): Promise<Response> {
  const headers = { ...cors(env, request), "Cache-Control": "no-store" };
  const reply = (status: number, body?: unknown) =>
    body === undefined
      ? new Response(null, { status, headers })
      : Response.json(body, { status, headers });

  if (request.method === "OPTIONS") return reply(204);

  const { pathname } = new URL(request.url);
  const id = pathname.slice(CONNECTIONS_PATH.length + 1);
  const listing = pathname === CONNECTIONS_PATH && request.method === "GET";
  const removing =
    pathname.startsWith(`${CONNECTIONS_PATH}/`) && request.method === "DELETE";
  if (!listing && !removing) return reply(404, { error: "not_found" });
  if (removing && !GRANT_ID.test(id)) return reply(404, { error: "not_found" });

  let uid: string;
  try {
    const token = getBearerToken(request);
    if (!token) throw new AuthError("Missing token", 401);
    uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return reply(error.status, { error: error.message });
  }

  const oauth = env.OAUTH_PROVIDER;
  if (listing) {
    return reply(200, { connections: await list(oauth, uid) });
  }
  // Keyed by reader as well as id, so only their own grant can go; one
  // that's already gone is gone either way.
  await oauth.revokeGrant(id, uid);
  console.log(JSON.stringify({ event: "mcp-disconnect", uid }));
  return reply(204);
}
