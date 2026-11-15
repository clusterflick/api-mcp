import { DATA_FORMAT_VERSION } from "@clusterflick/catalogue/data-format.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_EVERY_MS,
  clearListings,
  getListings,
  ListingsUnavailableError,
  RETRY_AFTER_MS,
} from "../src/listings";
import { call, connect, META, ORIGIN, release, serveSite } from "./helpers";

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearListings();
  vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fetched = (requests: { url: string }[]) =>
  requests.map(({ url }) => url.slice(`${ORIGIN}/data/`.length));

describe("the listings", () => {
  it("are found from current.json, never cached, then read and held", async () => {
    const { requests } = serveSite();
    const { data, meta } = await getListings(ORIGIN, Date.now());
    expect(meta).toBe(META);
    expect(fetched(requests)).toEqual([
      "current.json",
      META,
      "data.0.abcdefabcd.json",
    ]);
    expect(requests[0].cache).toBe("no-store");
    // Read as the site reads them: ids restored.
    expect(data.movies.m1.id).toBe("m1");
    expect(data.venues.rio.id).toBe("rio");
  });

  it("are used for five minutes before checking again", async () => {
    const { requests } = serveSite();
    const now = Date.now();
    await getListings(ORIGIN, now);
    await getListings(ORIGIN, now + CHECK_EVERY_MS - 1);
    expect(requests).toHaveLength(3);
    await getListings(ORIGIN, now + CHECK_EVERY_MS);
    // Only the pointer: it names the same release.
    expect(fetched(requests).slice(3)).toEqual(["current.json"]);
  });

  it("are shared by calls arriving together", async () => {
    const { requests } = serveSite();
    const now = Date.now();
    await Promise.all([getListings(ORIGIN, now), getListings(ORIGIN, now)]);
    expect(requests).toHaveLength(3);
  });

  it("are read again when the site publishes new ones", async () => {
    serveSite();
    const now = Date.now();
    await getListings(ORIGIN, now);
    const published = release();
    published.chunk.m1.title = "Halloween III";
    const next = "data.meta.9999999999.json";
    const { requests } = serveSite(published, {
      pointer: { formatVersion: DATA_FORMAT_VERSION, meta: next },
    });
    const { data, meta } = await getListings(ORIGIN, now + CHECK_EVERY_MS);
    expect(meta).toBe(next);
    expect(data.movies.m1.title).toBe("Halloween III");
    expect(fetched(requests)).toEqual([
      "current.json",
      next,
      "data.0.abcdefabcd.json",
    ]);
  });

  it("keep the last good copy when a check fails, and try again in a minute", async () => {
    serveSite();
    const now = Date.now();
    await getListings(ORIGIN, now);
    const { requests } = serveSite(release(), {
      pointer: { formatVersion: DATA_FORMAT_VERSION + 1, meta: META },
    });
    const later = now + CHECK_EVERY_MS;
    const { meta } = await getListings(ORIGIN, later);
    expect(meta).toBe(META);
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({
      event: "listings-unavailable",
      held: META,
    });
    await getListings(ORIGIN, later + RETRY_AFTER_MS - 1);
    expect(requests).toHaveLength(1);
    await getListings(ORIGIN, later + RETRY_AFTER_MS);
    expect(requests).toHaveLength(2);
  });

  it.each([
    [
      "a newer data format",
      { formatVersion: DATA_FORMAT_VERSION + 1, meta: META },
    ],
    [
      "no meta file",
      { formatVersion: DATA_FORMAT_VERSION, meta: "../secrets.json" },
    ],
  ])("are refused with %s, when none are held", async (_, pointer) => {
    serveSite(release(), { pointer });
    await expect(getListings(ORIGIN, Date.now())).rejects.toBeInstanceOf(
      ListingsUnavailableError,
    );
  });

  it("are refused when the site doesn't answer, when none are held", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Network connection lost."),
    );
    await expect(getListings(ORIGIN, Date.now())).rejects.toBeInstanceOf(
      ListingsUnavailableError,
    );
  });

  it("refused leave a tool saying it couldn't search, not that nothing's on", async () => {
    serveSite(release(), {
      pointer: { formatVersion: DATA_FORMAT_VERSION + 1, meta: META },
    });
    const { error } = await call(await connect(), "search_screenings");
    expect(error).toBe(
      "Clusterflick's listings couldn't be loaded just now. Try again in a minute.",
    );
  });
});
