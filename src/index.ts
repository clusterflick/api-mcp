import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { AUTHORIZE_PATH, handleDefault, type Props } from "./authorize";
import { handleMcp, MCP_PATH } from "./handler";

/**
 * The Worker: the OAuth library in front of the MCP endpoint. It serves the
 * discovery documents (`/.well-known/…`), client registration and the token
 * endpoint itself, answers `/mcp` without a valid token with the challenge
 * that sends an assistant to sign in, and leaves `/authorize` and
 * `/callback` to `authorize.ts`.
 */

const DAY = 86_400;

export const SCOPE = "listings";

const provider = new OAuthProvider<Env>({
  apiRoute: MCP_PATH,
  apiHandler: {
    fetch: (request, workerEnv, ctx) =>
      handleMcp(
        request,
        workerEnv,
        ctx as Parameters<typeof handleMcp>[2] & { props: Props },
      ),
  },
  defaultHandler: { fetch: handleDefault },
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: "/oauth/token",
  // Both ways an assistant can identify itself: a Client ID Metadata
  // Document, which MCP's 2026-07-28 spec prefers (with the
  // `global_fetch_strictly_public` flag), and registering, for those that
  // don't yet. Either way the reader approves it by name.
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [SCOPE, "offline_access"],
  requiredScopes: [SCOPE],
  resourceMetadata: {
    resource: `${env.MCP_ORIGIN}${MCP_PATH}`,
    authorization_servers: [env.MCP_ORIGIN],
    resource_name: "Clusterflick",
  },
  // An hour a token; a connection lasts while it's used, and ends after 30
  // days without a call, when the reader signs in again.
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * DAY,
  refreshTokenIdleTTL: 30 * DAY,
});

export default {
  fetch: (request, workerEnv, ctx) => provider.fetch(request, workerEnv, ctx),
  /**
   * KV's own expiry removes what has expired; this sweeps what it can't,
   * grants and tokens orphaned on the way, a batch a run, carrying on where
   * the last stopped (the library's KV cleanup).
   */
  async scheduled(_event, workerEnv) {
    const cursor = (await workerEnv.OAUTH_KV.get("purge-cursor")) ?? undefined;
    const result = await provider.purgeExpiredData(workerEnv, {
      batchSize: 100,
      cursor,
    });
    if (result.cursor)
      await workerEnv.OAUTH_KV.put("purge-cursor", result.cursor);
    else await workerEnv.OAUTH_KV.delete("purge-cursor");
  },
} satisfies ExportedHandler<Env>;
