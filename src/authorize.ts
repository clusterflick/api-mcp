import {
  authorizationErrorRedirect,
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { AuthError, verifyFirebaseToken, FIREBASE_JWKS } from "./auth";
import { hasAssistantAccess } from "./capability";
import { UpstreamError } from "./google-auth";
import { consentPage, htmlResponse, noticePage } from "./pages";
import type { JWTVerifyGetKey } from "jose";

/**
 * Signing a reader in for their assistant. The OAuth library owns the
 * protocol; these are the pages it leaves to us:
 *
 * 1. `GET /authorize`: the assistant sends the reader here. They're asked
 *    whether to allow it (`consentPage`).
 * 2. `POST /authorize`: they answered. Deny goes back to the assistant; allow
 *    goes to the site's /connect/, since Firebase's sign-in lives there, with
 *    the `state` the library made for the trip.
 * 3. `POST /callback?state=…`: /connect/ posts the reader's Firebase ID
 *    token. It's checked, and the account's `assistantAccess`, and the
 *    reader goes back to their assistant signed in as their uid.
 *
 * The library binds steps 1-2 and 2-3 to the reader's browser with cookies,
 * so another browser can't finish what this one started, and each step
 * works once, for ten minutes.
 */

export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";

/** The env the OAuth library hands its default handler: with its helpers. */
type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** What a token carries for the MCP handler (`ctx.props`). */
export type Props = { uid: string };

/** Google's keys for Firebase ID tokens; the tests use their own. */
let firebaseKeys: JWTVerifyGetKey = FIREBASE_JWKS;
export function useFirebaseKeys(keys: JWTVerifyGetKey) {
  firebaseKeys = keys;
}

const START_AGAIN = "Start connecting again from your assistant.";

/**
 * A failure the reader should see here, not be sent away with: only a
 * request whose client and redirect the library validated may be sent back.
 */
function failed(error: unknown) {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return htmlResponse(
      noticePage(
        "This sign-in can't continue",
        `It may have expired, been used already, or been opened in a different browser. ${START_AGAIN}`,
      ),
      { status: 400 },
    );
  }
  if (error instanceof CimdFetchError) {
    console.error(
      JSON.stringify({
        event: "mcp-sign-in",
        state: "client-unavailable",
        reason: error.reason,
      }),
    );
    return htmlResponse(
      noticePage(
        "We couldn't check your assistant",
        `Its details couldn't be fetched just now. ${START_AGAIN}`,
      ),
      { status: 502 },
    );
  }
  throw error;
}

async function showConsent(request: Request, env: AuthEnv) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    // First: a client that can't be described leaves nothing stored.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return htmlResponse(consentPage(details, consent.handle), {
      headers: consent.headers,
    });
  } catch (error) {
    return failed(error);
  }
}

async function answerConsent(request: Request, env: AuthEnv) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "allow") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      headers: approved.headers,
    });
    const connect = new URL(env.CONNECT_URL);
    connect.searchParams.set("state", state);
    headers.set("Location", connect.toString());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return failed(error);
  }
}

function backToAssistant(
  original: AuthRequest,
  headers: Headers,
  description: string,
) {
  headers.set(
    "Location",
    authorizationErrorRedirect(original, "access_denied", description),
  );
  return new Response(null, { status: 302, headers });
}

async function finishSignIn(request: Request, env: AuthEnv) {
  const oauth = env.OAUTH_PROVIDER;
  let resumed;
  try {
    resumed = await oauth.finishUpstream(request);
  } catch (error) {
    return failed(error);
  }
  const { request: original, headers } = resumed;

  const form = await request.formData().catch(() => undefined);
  const idToken = form?.get("idToken");
  let uid: string;
  try {
    if (typeof idToken !== "string" || idToken === "") {
      throw new AuthError("No token", 401);
    }
    uid = await verifyFirebaseToken(
      idToken,
      env.FIREBASE_PROJECT_ID,
      firebaseKeys,
    );
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    console.log(JSON.stringify({ event: "mcp-sign-in", state: "unverified" }));
    return backToAssistant(
      original,
      headers,
      "Signing in to Clusterflick failed",
    );
  }

  let granted: boolean;
  try {
    granted = await hasAssistantAccess(env, uid, { fresh: true });
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.error(
      JSON.stringify({
        event: "mcp-sign-in",
        state: "unavailable",
        message: error.message,
      }),
    );
    return htmlResponse(
      noticePage(
        "We couldn't finish signing you in",
        `Something on our side didn't answer. ${START_AGAIN}`,
      ),
      { status: 503, headers },
    );
  }
  if (!granted) {
    console.log(
      JSON.stringify({ event: "mcp-sign-in", state: "not-permitted", uid }),
    );
    // Told here, where they can read it, with the way back to the
    // assistant, which hears only that access was denied.
    return htmlResponse(
      noticePage(
        "AI assistant access is by invitation",
        "Your Clusterflick account hasn't been given access to search from an AI assistant yet.",
        {
          href: authorizationErrorRedirect(
            original,
            "access_denied",
            "This account doesn't have AI assistant access",
          ),
          label: "Back to your assistant",
        },
      ),
      { status: 403, headers },
    );
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: uid,
    metadata: {},
    scope: original.scope,
    props: { uid } satisfies Props,
  });
  console.log(
    JSON.stringify({ event: "mcp-sign-in", state: "connected", uid }),
  );
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Everything that isn't the MCP endpoint, or the library's own addresses. */
export async function handleDefault(request: Request, workerEnv: Env) {
  const env = workerEnv as AuthEnv;
  const { pathname } = new URL(request.url);
  if (pathname === AUTHORIZE_PATH && request.method === "GET") {
    return showConsent(request, env);
  }
  if (pathname === AUTHORIZE_PATH && request.method === "POST") {
    return answerConsent(request, env);
  }
  if (pathname === CALLBACK_PATH && request.method === "POST") {
    return finishSignIn(request, env);
  }
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
