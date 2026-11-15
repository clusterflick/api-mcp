import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  Browser,
  call,
  connect,
  granted,
  logged,
  MCP,
  ORIGIN,
  registerClient,
  request,
  resetWorker,
  serveSite,
  signFirebaseToken,
  signIn,
  type Store,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];
let uid = "";
let readers = 0;

/** A reader of the test's own, granted, with these lists. */
function reader(lists: Record<string, unknown> = {}): Store {
  return { ...granted(uid), [`users/${uid}`]: lists };
}

const entry = (title: string) => ({ title, addedAt: 1_794_700_000_000 });

/** Halloween on the watchlist, Cléo seen, the Rio among their venues. */
const LISTS = {
  watchlist: { m1: entry("Halloween") },
  seen: { m2: entry("Cléo from 5 to 7") },
  favouriteVenues: { rio: { name: "Rio Cinema", addedAt: 1_794_700_000_000 } },
};

beforeEach(() => {
  ({ log } = resetWorker());
  uid = `lists${++readers}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const titles = (value: { films: { title: string }[] }) =>
  value.films.map(({ title }) => title);

describe("the consent page", () => {
  it("offers the reader's lists, ticked", async () => {
    serveSite(undefined, { store: reader() });
    const { url } = await authorizeUrl(await registerClient());
    const html = await (await new Browser().fetch(url)).text();
    expect(html).toMatch(
      /<input type="checkbox" name="scope" value="lists" checked>/,
    );
    expect(html).toContain("watchlist, Seen list and venues");
  });
});

describe("a connection with the reader's lists", () => {
  it("marks what's on them", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid));
    const { value } = await call(client, "search_screenings");
    const byTitle = Object.fromEntries(
      value.films.map((film: { title: string }) => [film.title, film]),
    );
    expect(byTitle.Halloween).toMatchObject({ onWatchlist: true });
    expect(byTitle.Halloween.seen).toBeUndefined();
    expect(byTitle["Cléo from 5 to 7"]).toMatchObject({ seen: true });
    const rio = byTitle.Halloween.showings.find(
      ({ venue }: { venue: string }) => venue === "Rio Cinema",
    );
    expect(rio.yourVenue).toBe(true);
    const pcc = byTitle.Halloween.showings.find(
      ({ venue }: { venue: string }) => venue === "Prince Charles Cinema",
    );
    expect(pcc.yourVenue).toBeUndefined();
  });

  it("leaves out what they've seen, or keeps to their watchlist or venues", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid));
    const unseen = await call(client, "search_screenings", { hideSeen: true });
    expect(titles(unseen.value)).toEqual(["Halloween"]);
    const watchlist = await call(client, "search_screenings", {
      watchlistOnly: true,
    });
    expect(titles(watchlist.value)).toEqual(["Halloween"]);
    const venues = await call(client, "search_screenings", {
      myVenuesOnly: true,
    });
    expect(titles(venues.value)).toEqual(["Halloween"]);
    expect(
      venues.value.films[0].showings.map(
        ({ venue }: { venue: string }) => venue,
      ),
    ).toEqual(["Rio Cinema"]);
  });

  it("reads them fresh on every call", async () => {
    let store = reader(LISTS);
    serveSite(undefined, {
      get store() {
        return store;
      },
    });
    const client = await connect(await signIn(uid));
    expect(
      titles(
        (await call(client, "search_screenings", { hideSeen: true })).value,
      ),
    ).toEqual(["Halloween"]);
    store = reader({
      ...LISTS,
      seen: { ...LISTS.seen, m1: entry("Halloween") },
    });
    expect(
      titles(
        (await call(client, "search_screenings", { hideSeen: true })).value,
      ),
    ).toEqual([]);
  });

  it("marks a film and a venue on their own", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid));
    expect(
      (await call(client, "get_film", { title: "Halloween" })).value,
    ).toMatchObject({ onWatchlist: true });
    const { value } = await call(client, "list_venues");
    expect(
      value.venues.find(({ name }: { name: string }) => name === "Rio Cinema"),
    ).toMatchObject({ yourVenue: true });
  });

  it.each([
    [{ watchlistOnly: true }, { watchlist: {} }, "watchlist is empty"],
    [
      { myVenuesOnly: true },
      { favouriteVenues: {} },
      "any venues to My Venues",
    ],
  ])(
    "refuses %o when that list is empty, rather than everything",
    async (input, lists, message) => {
      serveSite(undefined, { store: reader({ ...LISTS, ...lists }) });
      const client = await connect(await signIn(uid));
      expect((await call(client, "search_screenings", input)).error).toContain(
        message,
      );
    },
  );

  it("says so when their lists can't be read, rather than ignoring them", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid));
    // Firestore goes down after sign-in; the capability is remembered.
    serveSite(undefined, { store: reader(LISTS), firestoreStatus: 503 });
    expect((await call(client, "search_screenings")).error).toContain(
      "lists couldn't be read",
    );
  });

  it("logs that they were used, never what's on them", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid));
    await call(client, "search_screenings", { watchlistOnly: true });
    const [line] = logged(log, "mcp-call");
    expect(line).toMatchObject({ lists: true, outcome: "answered" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("m1");
  });
});

describe("a connection without the reader's lists", () => {
  it("never reads them, and marks nothing", async () => {
    const { requests } = serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid, { lists: false }));
    const { value } = await call(client, "search_screenings");
    expect(
      value.films.some(
        (film: object) => "onWatchlist" in film || "seen" in film,
      ),
    ).toBe(false);
    expect(requests.some(({ url }) => url.includes(":batchGet"))).toBe(false);
    expect(logged(log, "mcp-call")[0]).toMatchObject({ lists: false });
  });

  it("says how to allow them when asked to use them", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    const client = await connect(await signIn(uid, { lists: false }));
    expect(
      (await call(client, "search_screenings", { hideSeen: true })).error,
    ).toContain("connect again with their lists ticked");
  });

  it("is listed with what it was allowed", async () => {
    serveSite(undefined, { store: reader(LISTS) });
    await signIn(uid, { lists: false });
    await signIn(uid);
    const response = await request(`${MCP}/connections`, {
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: uid })}`,
        Origin: ORIGIN,
      },
    });
    const { connections } = (await response.json()) as {
      connections: { scopes: string[] }[];
    };
    expect(
      connections.map(({ scopes }) => scopes.includes("lists")).sort(),
    ).toEqual([false, true]);
    for (const { scopes } of connections) expect(scopes).toContain("listings");
  });
});
