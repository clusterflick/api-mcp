import { Firestore } from "./firestore";
import { getAccessToken, UpstreamError } from "./google-auth";

/**
 * Whether a reader has `assistantAccess`, which the site grants one account
 * at a time (`npm run grant-capability`): `users/{uid}/meta/capabilities`
 * holding the id. Checked when they sign in, and again on their calls.
 */
export const CAPABILITY = "assistantAccess";

/**
 * How long an answer is used before Firestore is asked again: a revoked
 * capability stops a reader's calls within five minutes, as a profile's
 * cached copy is read again after five in api-profiles.
 */
export const CAPABILITY_TTL_MS = 5 * 60_000;

/** A Firebase uid: what the site's rules let into a document path. */
const UID = /^[A-Za-z0-9]{1,128}$/;

const answers = new Map<string, { granted: boolean; checkedAt: number }>();

/** For the tests: forget every answer, as a new isolate would. */
export function clearCapabilities() {
  answers.clear();
}

type CapabilityEnv = Pick<
  Env,
  "FIREBASE_PROJECT_ID" | "FIREBASE_SERVICE_ACCOUNT"
>;

/**
 * Whether `uid` has the capability. `fresh` asks Firestore whatever was
 * remembered: at sign-in, so a reader granted it a minute ago can connect.
 * Throws `UpstreamError` when Firestore can't be asked, rather than guessing
 * either way.
 */
export async function hasAssistantAccess(
  env: CapabilityEnv,
  uid: string,
  { fresh = false, now = Date.now() } = {},
): Promise<boolean> {
  if (!UID.test(uid)) throw new UpstreamError(`Not a uid: ${uid}`);
  const known = answers.get(uid);
  if (!fresh && known && now - known.checkedAt < CAPABILITY_TTL_MS) {
    return known.granted;
  }
  const db = new Firestore(env.FIREBASE_PROJECT_ID, () =>
    getAccessToken(env.FIREBASE_SERVICE_ACCOUNT),
  );
  const capabilities = await db.get(`users/${uid}/meta/capabilities`);
  const granted = capabilities !== null && CAPABILITY in capabilities;
  answers.set(uid, { granted, checkedAt: now });
  return granted;
}
