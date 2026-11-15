import {
  CURRENT_DATA_FILE,
  DATA_FORMAT_VERSION,
} from "@clusterflick/catalogue/data-format.mjs";
import type {
  CinemaData,
  CurrentData,
  MetaData,
  Movie,
} from "@clusterflick/catalogue/types";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { readListings } from "@clusterflick/catalogue/utils/read-listings";

/**
 * The listings, as the site publishes them, held in the isolate: 13MB of
 * JSON, about 21MB parsed, read once and shared by every call the isolate
 * serves. Every few minutes a call checks whether the site has published new
 * ones, which costs one small fetch when it hasn't.
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

export class ListingsUnavailableError extends Error {
  name = "ListingsUnavailableError";
}

let current: Listings | undefined;
let checkAfter = 0;
let pending: Promise<Listings> | undefined;

/** For the tests: forget what's held, as a new isolate would. */
export function clearListings() {
  current = undefined;
  checkAfter = 0;
  pending = undefined;
}

const META_FILE = /^data\.meta\.[0-9a-f]{10}\.json$/;
const CHUNK_FILE = /^data\.\d+\.[0-9a-f]{10}\.json$/;

/**
 * A file of the site's, or why it couldn't be read: no answer, an error, or
 * something that isn't JSON are all the listings being unavailable.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new ListingsUnavailableError(`${url} didn't answer: ${error}`);
  }
  if (!response.ok) {
    throw new ListingsUnavailableError(`${url} answered ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ListingsUnavailableError(`${url} isn't JSON: ${error}`);
  }
}

function checkFormat(version: unknown, file: string) {
  if (version !== DATA_FORMAT_VERSION) {
    throw new ListingsUnavailableError(
      `${file} is in data format ${String(version)}; this Worker reads ` +
        `${DATA_FORMAT_VERSION}. Update @clusterflick/catalogue.`,
    );
  }
}

async function load(origin: string, now: number): Promise<Listings> {
  const base = `${origin}/data/`;
  // Never from a cache: it's how a new release is noticed.
  const pointer = await fetchJson<CurrentData>(base + CURRENT_DATA_FILE, {
    cache: "no-store",
  });
  checkFormat(pointer.formatVersion, CURRENT_DATA_FILE);
  if (typeof pointer.meta !== "string" || !META_FILE.test(pointer.meta)) {
    throw new ListingsUnavailableError(
      `${CURRENT_DATA_FILE} names no meta file: ${JSON.stringify(pointer.meta)}`,
    );
  }

  const today = timestampToLondonDateString(now);
  if (current && current.meta === pointer.meta && current.readOn === today) {
    return current;
  }

  const started = Date.now();
  // Named by their content, so these can come from a cache.
  const meta = await fetchJson<MetaData>(base + pointer.meta);
  checkFormat(meta.formatVersion, pointer.meta);
  const bad = meta.filenames.find((name) => !CHUNK_FILE.test(name));
  if (bad !== undefined) {
    throw new ListingsUnavailableError(
      `${pointer.meta} names a chunk that isn't one: ${JSON.stringify(bad)}`,
    );
  }
  const chunks = await Promise.all(
    meta.filenames.map((name) => fetchJson<Record<string, Movie>>(base + name)),
  );
  const data = readListings(meta, chunks);
  console.log(
    JSON.stringify({
      event: "listings-loaded",
      meta: pointer.meta,
      generatedAt: meta.generatedAt,
      films: Object.keys(data.movies).length,
      ms: Date.now() - started,
    }),
  );
  return { data, meta: pointer.meta, readOn: today };
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
