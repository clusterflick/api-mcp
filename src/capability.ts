import {
  CapabilityId,
  RememberedCapability,
} from "@clusterflick/accounts/capabilities";
import { Firestore } from "@clusterflick/accounts/firestore";
import { getAccessToken } from "@clusterflick/accounts/google-auth";

/**
 * Whether a reader has `assistantAccess`, which the site grants one account
 * at a time (`npm run grant-capability`). Checked when they sign in, and
 * again on their calls.
 */
export const CAPABILITY = CapabilityId.AssistantAccess;

/**
 * How long an answer is used before Firestore is asked again: a revoked
 * capability stops a reader's calls within five minutes, as a profile's
 * cached copy is read again after five in api-profiles.
 */
export const CAPABILITY_TTL_MS = 5 * 60_000;

const access = new RememberedCapability(CAPABILITY, CAPABILITY_TTL_MS);

/** For the tests: forget every answer, as a new isolate would. */
export function clearCapabilities() {
  access.clear();
}

type CapabilityEnv = Pick<
  Env,
  "FIREBASE_PROJECT_ID" | "FIREBASE_SERVICE_ACCOUNT"
>;

/**
 * Whether `uid` has the capability. `fresh` asks Firestore whatever was
 * remembered: at sign-in, so a reader granted it a minute ago can connect.
 * Throws `UpstreamError` when Firestore can't be asked, or for anything that
 * isn't a uid, rather than guessing either way.
 */
export function hasAssistantAccess(
  env: CapabilityEnv,
  uid: string,
  options: { fresh?: boolean; now?: number } = {},
): Promise<boolean> {
  const db = new Firestore(env.FIREBASE_PROJECT_ID, () =>
    getAccessToken(env.FIREBASE_SERVICE_ACCOUNT),
  );
  return access.has(db, uid, options);
}
