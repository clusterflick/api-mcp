import { EVENT_CATEGORIES } from "@clusterflick/catalogue/filters/event-categories";
import {
  FilterId,
  apply,
  buildFilterUrl,
  describeFilters,
  getDefaultState,
  type FilterState,
} from "@clusterflick/catalogue/filters";
import { normalizeToWords } from "@clusterflick/catalogue/filters/normalize";
import {
  getVenueIdsNear,
  type PlaceRadius,
} from "@clusterflick/catalogue/places";
import type { CinemaData, Movie } from "@clusterflick/catalogue/types";
import {
  addLondonDays,
  dateStringToLondonTimestamp,
  getLondonMidnightTimestamp,
  timeStringToMinutes,
  timestampToLondonDateString,
} from "@clusterflick/catalogue/utils/format-date";
import { getCinemaVenueIds } from "@clusterflick/catalogue/utils/get-cinema-venue-ids";
import { getVenueIdsWithShowings } from "@clusterflick/catalogue/utils/get-venues-with-showings";
import { getDistanceInMiles } from "@clusterflick/catalogue/utils/geo-distance";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { UpstreamError } from "./google-auth";
import { getListings, ListingsUnavailableError } from "./listings";
import {
  presentFilm,
  presentPerformances,
  presentVenue,
  type Marks,
} from "./present";
import {
  applyValues,
  resolvePlace,
  resolveValue,
  ResolveError,
  type Kind,
  type Place,
} from "./resolve";
import type { ReaderLists } from "./reader-lists";

export const SERVER_NAME = "clusterflick";
export const SERVER_VERSION = "0.1.0";

/** A tool's answer: JSON, which an assistant reads as well as prose. */
const answer = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * A tool's refusal, in words the assistant can act on. Only for what the
 * assistant asked or what's down; anything else is a bug, and throws.
 */
const refusal = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * A tool's answer, and its log line: who asked, which tool, how it went and
 * how long it took. Never what was searched for, which says what someone's
 * planning to do.
 */
async function run(
  origin: string,
  reader: Reader,
  name: string,
  tool: (data: CinemaData, marks: Marks) => unknown | Promise<unknown>,
) {
  const started = Date.now();
  const log = (outcome: string) =>
    console.log(
      JSON.stringify({
        event: "mcp-call",
        uid: reader.uid,
        tool: name,
        outcome,
        // Whether their lists were read: never what's on them.
        lists: reader.canSeeLists,
        ms: Date.now() - started,
      }),
    );
  try {
    const { data } = await getListings(origin);
    let marks: Marks = null;
    if (reader.canSeeLists) {
      try {
        marks = await reader.readLists();
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        console.error(
          JSON.stringify({
            event: "mcp-lists-unavailable",
            uid: reader.uid,
            message: error.message,
          }),
        );
        log("unavailable");
        // Not answered without them: an answer that quietly ignores the
        // reader's lists would suggest what they've seen.
        return refusal(
          "Your Clusterflick lists couldn't be read just now. Try again in a minute.",
        );
      }
    }
    const result = answer(await tool(data, marks));
    log("answered");
    return result;
  } catch (error) {
    if (error instanceof ResolveError) {
      log("refused");
      return refusal(error.message);
    }
    if (error instanceof ListingsUnavailableError) {
      log("unavailable");
      return refusal(
        "Clusterflick's listings couldn't be loaded just now. Try again in a minute.",
      );
    }
    log("failed");
    throw error;
  }
}

const words = (description: string) =>
  z.array(z.string().min(1)).min(1).optional().describe(description);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const londonDate = z
  .string()
  .regex(DATE, "A date in London, as YYYY-MM-DD")
  .optional();
const londonClock = z
  .string()
  .regex(TIME, "A time of day in London, as HH:MM, 24-hour")
  .optional();

const placeInput = {
  near: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A London station (Tube, Overground, Elizabeth line or DLR) or a venue, by name. Not a postcode or a borough.",
    ),
  withinMiles: z
    .number()
    .min(0.1)
    .max(10)
    .optional()
    .describe(
      "How far from `near`. Without it, the site's own rule: from half a mile, widening to find ten venues, up to two miles.",
    ),
};

const searchInput = z.object({
  title: z
    .string()
    .min(1)
    .optional()
    .describe("Words in the film's or event's title."),
  from: londonDate.describe("First day, YYYY-MM-DD in London. Default: today."),
  to: londonDate.describe(
    "Last day, YYYY-MM-DD in London, included. Default: a week after `from`.",
  ),
  startingFrom: londonClock.describe(
    "Earliest start time each day, HH:MM in London.",
  ),
  startingBy: londonClock.describe(
    "Latest start time each day, HH:MM in London.",
  ),
  ...placeInput,
  venues: words("Venues by name. Not with `near`."),
  categories: words(
    "Kinds of event: films, multiple films, short films, TV, quizzes, comedy, music, talks, workshops, other events. Default: films, multiple films and short films.",
  ),
  genres: words("Genres, any of them: horror, documentary, animation…"),
  directors: words("Directors, by name; any of them."),
  cast: words("Cast members, by name; any of them."),
  accessibility: words(
    "Any of: subtitles, audio description, relaxed, baby friendly, dog friendly, hard of hearing.",
  ),
  occasions: words(
    "Any of: intro, Q&A, in conversation, panel, guest appearance, live score, premiere, preview.",
  ),
  formats: words("Any of: 35mm, 70mm, 16mm, IMAX, 3D, VHS…"),
  festivals: words("Festivals, by name."),
  filmClubs: words("Film clubs, by name."),
  minLetterboxd: z.number().min(0).max(5).optional().describe("Out of 5."),
  minImdb: z.number().min(0).max(10).optional().describe("Out of 10."),
  minRottenTomatoes: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Tomatometer, 0-100."),
  hideSoldOut: z.boolean().optional(),
  hideSeen: z
    .boolean()
    .optional()
    .describe("Leave out films on the reader's Seen list. Needs their lists."),
  watchlistOnly: z
    .boolean()
    .optional()
    .describe("Only films on the reader's watchlist. Needs their lists."),
  myVenuesOnly: z
    .boolean()
    .optional()
    .describe(
      "Only the reader's venues (My Venues); with `near`, those of them near it. Needs their lists.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Films to return, soonest first. Default 10."),
  showingsPerFilm: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Showings to return for each film, soonest first. Default 3."),
});

type SearchInput = z.infer<typeof searchInput>;

function parseDate(value: string, name: string): number {
  const time = dateStringToLondonTimestamp(value);
  if (Number.isNaN(time) || timestampToLondonDateString(time) !== value) {
    throw new ResolveError(`\`${name}\` isn't a date: "${value}".`);
  }
  return time;
}

function resolveAll(data: CinemaData, kind: Kind, values?: string[]) {
  return (values ?? []).map((value) => resolveValue(data, kind, value));
}

/** The venues with something on within reach of a place, as the site picks them. */
function venuesNear(data: CinemaData, place: Place, withinMiles?: number) {
  const showing = getVenueIdsWithShowings(data.movies);
  const venues = Object.fromEntries(
    Object.entries(data.venues).filter(([id]) => showing.has(id)),
  );
  const radius: PlaceRadius = withinMiles ?? "auto";
  return { radius, ids: getVenueIdsNear(place.point, radius, venues) };
}

/**
 * What a connection without the reader's lists says when asked to use them:
 * how to give them, rather than an answer that ignores them.
 */
export const NO_LISTS =
  "This connection can't see the reader's Clusterflick lists. To allow it, they disconnect it in the AI assistant panel at clusterflick.com/personalise, then connect again with their lists ticked.";

async function buildSearch(data: CinemaData, input: SearchInput, marks: Marks) {
  let state: FilterState = getDefaultState();
  const today = getLondonMidnightTimestamp();
  const from = input.from ? parseDate(input.from, "from") : today;
  const to = input.to ? parseDate(input.to, "to") : addLondonDays(from, 7);
  if (to < from) throw new ResolveError("`to` is before `from`.");
  state = { ...state, [FilterId.DateRange]: { start: from, end: to } };

  if (input.startingFrom || input.startingBy) {
    const start = input.startingFrom
      ? timeStringToMinutes(input.startingFrom)
      : 0;
    const end = input.startingBy ? timeStringToMinutes(input.startingBy) : 1439;
    if (end < start) {
      throw new ResolveError("`startingBy` is before `startingFrom`.");
    }
    state = { ...state, [FilterId.TimeRange]: { start, end } };
  }

  if (input.title) state = { ...state, [FilterId.Search]: input.title };
  if (input.categories) state = { ...state, [FilterId.Categories]: null };

  state = applyValues(state, [
    ...resolveAll(data, "category", input.categories),
    ...resolveAll(data, "genre", input.genres),
    ...resolveAll(data, "director", input.directors),
    ...resolveAll(data, "cast", input.cast),
    ...resolveAll(data, "accessibility", input.accessibility),
    ...resolveAll(data, "occasion", input.occasions),
    ...resolveAll(data, "format", input.formats),
    ...resolveAll(data, "festival", input.festivals),
    ...resolveAll(data, "filmClub", input.filmClubs),
    ...resolveAll(data, "venue", input.venues),
  ]);

  let venueOrigin = null;
  if (input.near) {
    if (input.venues) {
      throw new ResolveError("Give `near` or `venues`, not both.");
    }
    const place = await resolvePlace(data, input.near);
    const { radius, ids } = venuesNear(data, place, input.withinMiles);
    state = { ...state, [FilterId.Venues]: ids };
    venueOrigin = {
      place: place.ref,
      label: place.label,
      point: place.point,
      radius,
      venues: ids,
    };
  } else if (input.withinMiles !== undefined) {
    throw new ResolveError("`withinMiles` needs `near`.");
  }

  if (input.hideSeen || input.watchlistOnly || input.myVenuesOnly) {
    if (!marks) throw new ResolveError(NO_LISTS);
  }
  if (marks && input.hideSeen) {
    state = { ...state, [FilterId.HideSeen]: [...marks.seen] };
  }
  if (marks && input.watchlistOnly) {
    // An empty selection is no filter at all: refused, not every film.
    if (marks.watchlist.size === 0) {
      throw new ResolveError("The reader's watchlist is empty.");
    }
    state = { ...state, [FilterId.Movies]: [...marks.watchlist] };
  }
  if (marks && input.myVenuesOnly) {
    if (input.venues) {
      throw new ResolveError("Give `myVenuesOnly` or `venues`, not both.");
    }
    if (marks.venues.size === 0) {
      throw new ResolveError(
        "The reader hasn't added any venues to My Venues.",
      );
    }
    const near = state[FilterId.Venues];
    const mine = near
      ? near.filter((id) => marks.venues.has(id))
      : [...marks.venues];
    state = { ...state, [FilterId.Venues]: mine };
    if (venueOrigin) venueOrigin = null;
  }

  if (input.minLetterboxd !== undefined) {
    state = { ...state, [FilterId.LetterboxdRating]: input.minLetterboxd };
  }
  if (input.minImdb !== undefined) {
    state = { ...state, [FilterId.ImdbRating]: input.minImdb };
  }
  if (input.minRottenTomatoes !== undefined) {
    state = {
      ...state,
      [FilterId.RottenTomatoesRating]: input.minRottenTomatoes,
    };
  }
  if (input.hideSoldOut) state = { ...state, [FilterId.HideSoldOut]: true };
  return { state, venueOrigin };
}

const firstTime = (movie: Movie) =>
  Math.min(...movie.performances.map(({ time }) => time));

export function searchScreenings(
  data: CinemaData,
  origin: string,
  search: Awaited<ReturnType<typeof buildSearch>>,
  input: Pick<SearchInput, "limit" | "showingsPerFilm">,
  marks: Marks = null,
) {
  const { state, venueOrigin } = search;
  const found = Object.values(apply(data.movies, state)).sort(
    (a, b) => firstTime(a) - firstTime(b) || a.title.localeCompare(b.title),
  );
  // A week of London is ~500 films: the defaults keep an answer to about
  // 10,000 characters of the assistant's context, and `onClusterflick` has
  // the rest.
  const limit = input.limit ?? 10;
  const perFilm = input.showingsPerFilm ?? 3;
  const description = describeFilters({
    state,
    categories: EVENT_CATEGORIES,
    venues: data.venues,
    genres: data.genres,
    people: data.people,
    movies: data.movies,
    cinemaVenueIds: getCinemaVenueIds(data.venues),
    venueOrigin,
  });
  return {
    searched: `${description.events} • ${description.venues} • ${description.dates}`,
    totalFilms: found.length,
    films: found.slice(0, limit).map((movie) => ({
      ...presentFilm(data, movie, origin, { marks }),
      ...presentPerformances(data, movie, origin, perFilm, marks),
    })),
    // The same search on the site, for everything past the limit.
    onClusterflick: buildFilterUrl(state, `${origin}/catalogue/`),
  };
}

function findFilm(data: CinemaData, title: string, year?: string) {
  const wanted = normalizeToWords(title).join(" ");
  const named = (movie: Movie) =>
    [movie.title, movie.originalTitle]
      .filter((name): name is string => Boolean(name))
      .map((name) => normalizeToWords(name).join(" "));
  const all = Object.values(data.movies).filter(
    (movie) => !year || movie.year === year,
  );
  const exact = all.filter((movie) => named(movie).includes(wanted));
  const matches =
    exact.length > 0
      ? exact
      : all.filter((movie) =>
          named(movie).some((name) => ` ${name} `.includes(` ${wanted} `)),
        );
  if (matches.length === 1) return matches[0];
  const label = (movie: Movie) =>
    movie.year ? `${movie.title} (${movie.year})` : movie.title;
  if (matches.length > 1) {
    const listed = matches.slice(0, 10).map(label).join("; ");
    throw new ResolveError(
      `"${title}" could be more than one film showing: ${listed}` +
        `${matches.length > 10 ? `; and ${matches.length - 10} more` : ""}. ` +
        `Give the full title, or the year.`,
    );
  }
  throw new ResolveError(
    `Nothing called "${title}"${year ? ` from ${year}` : ""} is showing in London.`,
  );
}

/** Who's asking, and whether this connection may read their lists. */
export type Reader = {
  uid: string;
  canSeeLists: boolean;
  readLists: () => Promise<ReaderLists>;
};

/**
 * The MCP server: a fresh one for each request, as the handler asks, for the
 * reader making it.
 */
export function createServer(origin: string, reader: Reader) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Clusterflick lists every film showing in London, from 450+ cinemas and venues. Times are London time. Link people to the `url` of a film or venue, and to `bookingUrl` to book. When the reader has allowed their lists, results are marked `onWatchlist`, `seen` and `yourVenue`, and searches can leave out what they've seen or keep to their watchlist or venues.",
    },
  );
  const annotations = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "search_screenings",
    {
      title: "Search London screenings",
      description:
        "Films and events showing in London, soonest first, with their showings. Defaults to films over the next week, everywhere. Every value is plain words, as a person would say them; a value that names nothing, or more than one thing, is an error saying which.",
      inputSchema: searchInput,
      annotations,
    },
    (input) =>
      run(origin, reader, "search_screenings", async (data, marks) =>
        searchScreenings(
          data,
          origin,
          await buildSearch(data, input, marks),
          input,
          marks,
        ),
      ),
  );

  server.registerTool(
    "get_film",
    {
      title: "Get a film",
      description:
        "One film or event by title: what it is, and every showing from today, soonest first.",
      inputSchema: z.object({
        title: z.string().min(1).describe("The title, as it's listed."),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe("The year of release, when titles clash."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Showings to return. Default 30."),
      }),
      annotations,
    },
    ({ title, year, limit }) =>
      run(origin, reader, "get_film", (data, marks) => {
        const movie = findFilm(data, title, year);
        // Only what hasn't started: the site hides a finished showing too.
        const upcoming = apply(
          { [movie.id]: movie },
          {
            ...getDefaultState(),
            [FilterId.Categories]: null,
            [FilterId.DateRange]: { start: null, end: null },
          },
        )[movie.id] ?? { ...movie, performances: [], showings: {} };
        return {
          ...presentFilm(data, movie, origin, { detailed: true, marks }),
          ...presentPerformances(data, upcoming, origin, limit ?? 30, marks),
        };
      }),
  );

  server.registerTool(
    "list_venues",
    {
      title: "List London venues",
      description:
        "The cinemas and venues with something showing: all of them by name, or those near a place, nearest first.",
      inputSchema: z.object({
        ...placeInput,
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Venues to return. Default 50."),
      }),
      annotations,
    },
    ({ near, withinMiles, limit }) =>
      run(origin, reader, "list_venues", async (data, marks) => {
        const showing = getVenueIdsWithShowings(data.movies);
        let venues = Object.values(data.venues)
          .filter(({ id }) => showing.has(id))
          .sort((a, b) => a.name.localeCompare(b.name));
        let place: Place | undefined;
        if (near) {
          place = await resolvePlace(data, near);
          const ids = new Set(venuesNear(data, place, withinMiles).ids);
          const from = place.point;
          venues = venues
            .filter(({ id }) => ids.has(id))
            .sort(
              (a, b) =>
                getDistanceInMiles(from, a.geo) -
                getDistanceInMiles(from, b.geo),
            );
        } else if (withinMiles !== undefined) {
          throw new ResolveError("`withinMiles` needs `near`.");
        }
        return {
          ...(place ? { near: place.label } : {}),
          totalVenues: venues.length,
          venues: venues.slice(0, limit ?? 50).map((venue) => ({
            ...presentVenue(venue, origin, marks),
            ...(place
              ? {
                  miles:
                    Math.round(
                      getDistanceInMiles(place.point, venue.geo) * 10,
                    ) / 10,
                }
              : {}),
          })),
        };
      }),
  );

  return server;
}
