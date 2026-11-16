import type { CinemaData } from "@clusterflick/catalogue/types";
import {
  fetchCurrentRelease,
  fetchRelease,
  ListingsUnavailableError,
} from "@clusterflick/catalogue/utils/fetch-listings";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";

export { ListingsUnavailableError };

/**
 * The listings, as the site publishes them, held in the isolate: 13MB of
 * JSON, about 21MB parsed, read once and shared by every call the isolate
 * serves. Every few minutes a call checks whether the site has published new
 * ones, which costs one small fetch when it hasn't. The fetching and its
 * checks are `@clusterflick/catalogue`'s (`fetch-listings`), which the alerts
 * Worker shares; holding them, and carrying on with the last good copy when a
 * check fails, are this Worker's.
 */

/** How long the listings are used before checking for new ones. */
export const CHECK_EVERY_MS = 5 * 60_000;

/** How long to wait before trying again after a check failed. */
export const RETRY_AFTER_MS = 60_000;

export type Listings = {
  data: CinemaData;
  /** The meta file they were read from, which names this release. */
  meta: string;
  /** The London date they were read on: past days are dropped on reading. */
  readOn: string;
};

let current: Listings | undefined;
let checkAfter = 0;
let pending: Promise<Listings> | undefined;

/** For the tests: forget what's held, as a new isolate would. */
export function clearListings() {
  current = undefined;
  checkAfter = 0;
  pending = undefined;
}

async function load(origin: string, now: number): Promise<Listings> {
  const meta = await fetchCurrentRelease(origin);
  const today = timestampToLondonDateString(now);
  if (current && current.meta === meta && current.readOn === today) {
    return current;
  }
  const started = Date.now();
  const data: CinemaData = await fetchRelease(origin, meta);
  console.log(
    JSON.stringify({
      event: "listings-loaded",
      meta,
      generatedAt: data.generatedAt,
      films: Object.keys(data.movies).length,
      ms: Date.now() - started,
    }),
  );
  return { data, meta, readOn: today };
}

/**
 * The listings, checking for new ones when they're due. A failed check keeps
 * the listings already held, and logs why; with none held, it throws, so a
 * tool answers that it couldn't search rather than finding nothing.
 */
export async function getListings(
  origin: string,
  now = Date.now(),
): Promise<Listings> {
  if (current && now < checkAfter) return current;
  // Calls arriving together share one check.
  pending ??= load(origin, now).finally(() => {
    pending = undefined;
  });
  try {
    current = await pending;
    checkAfter = now + CHECK_EVERY_MS;
    return current;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "listings-unavailable",
        message: error instanceof Error ? error.message : String(error),
        held: current?.meta ?? null,
      }),
    );
    if (!current) throw error;
    checkAfter = now + RETRY_AFTER_MS;
    return current;
  }
}
