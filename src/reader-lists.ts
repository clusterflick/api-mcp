import { Firestore } from "./firestore";
import { getAccessToken } from "./google-auth";
import { readFavouriteVenues, readList } from "./lists";

/**
 * A reader's watchlist, Seen list and venues, as the ids the catalogue's
 * filters take: the keys of `users/{uid}`'s `watchlist`, `seen` and
 * `favouriteVenues`, the fields the site writes them to.
 *
 * Read fresh for each call that uses them, never remembered: a film marked
 * seen on the site a minute ago mustn't be suggested. It's one read of one
 * document, masked to those three fields. If that ever costs too much, the
 * site already tells api-profiles when a reader's lists change, and could
 * tell this Worker too.
 */
export type ReaderLists = {
  watchlist: Set<string>;
  seen: Set<string>;
  venues: Set<string>;
};

const FIELDS = ["watchlist", "seen", "favouriteVenues"];

/** Throws `UpstreamError` when Firestore can't be asked. */
export async function readReaderLists(
  env: Pick<Env, "FIREBASE_PROJECT_ID" | "FIREBASE_SERVICE_ACCOUNT">,
  uid: string,
): Promise<ReaderLists> {
  const db = new Firestore(env.FIREBASE_PROJECT_ID, () =>
    getAccessToken(env.FIREBASE_SERVICE_ACCOUNT),
  );
  const [user] = await db.batchGet([`users/${uid}`], FIELDS);
  return {
    watchlist: new Set(Object.keys(readList(user?.watchlist))),
    seen: new Set(Object.keys(readList(user?.seen))),
    venues: new Set(Object.keys(readFavouriteVenues(user?.favouriteVenues))),
  };
}
