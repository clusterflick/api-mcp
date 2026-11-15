import { EVENT_CATEGORIES } from "@clusterflick/catalogue/filters/event-categories";
import {
  FilterId,
  buildFilterSearchGroups,
  getPeopleVocabulary,
  searchFilterGroups,
  type FilterSearchEntry,
  type FilterState,
} from "@clusterflick/catalogue/filters";
import { normalizeToWords } from "@clusterflick/catalogue/filters/normalize";
import {
  formatPlaceRef,
  loadStations,
  type Station,
} from "@clusterflick/catalogue/places";
import type { CinemaData, Position } from "@clusterflick/catalogue/types";
import { getVenueIdsWithShowings } from "@clusterflick/catalogue/utils/get-venues-with-showings";

/**
 * The words a tool is given ("horror", "subtitled", "Agnès Varda", "Rio")
 * turned into the filters' values, with the site's own vocabulary: its
 * labels and aliases, the people credited on what's showing, and the venues
 * showing it. A word that names nothing, or names several things, is an
 * error that says so, never a filter left off: a search quietly wider than
 * the one asked for reads as an answer.
 */

export class ResolveError extends Error {
  name = "ResolveError";
}

/** What a tool's input can name, and the filters each kind is found in. */
export const KINDS = {
  category: { label: "event type", filters: [FilterId.Categories] },
  genre: { label: "genre", filters: [FilterId.Genres] },
  format: {
    label: "format",
    filters: [
      FilterId.FormatSource,
      FilterId.FormatPresentation,
      FilterId.FormatDimension,
    ],
  },
  accessibility: { label: "accessibility", filters: [FilterId.Accessibility] },
  occasion: { label: "occasion", filters: [FilterId.Occasions] },
  director: { label: "director", filters: [FilterId.Directors] },
  cast: { label: "cast member", filters: [FilterId.Cast] },
  festival: { label: "festival", filters: [FilterId.Festivals] },
  filmClub: { label: "film club", filters: [FilterId.FilmClubs] },
  venue: { label: "venue", filters: [FilterId.Venues] },
} as const;

export type Kind = keyof typeof KINDS;

/**
 * Kinds with few enough values to list in an error, so the assistant can
 * pick one rather than guess again.
 */
const LISTED: ReadonlySet<Kind> = new Set([
  "category",
  "genre",
  "format",
  "accessibility",
  "occasion",
]);

type Vocabulary = Record<Kind, FilterSearchEntry[][]>;

/** Built once per release, on first use: the people take a pass over every film. */
const vocabularies = new WeakMap<CinemaData, Vocabulary>();

function getVocabulary(data: CinemaData): Vocabulary {
  let vocabulary = vocabularies.get(data);
  if (vocabulary) return vocabulary;
  const showing = getVenueIdsWithShowings(data.movies);
  const groups = buildFilterSearchGroups({
    categories: EVENT_CATEGORIES,
    genres: data.genres,
    people: getPeopleVocabulary(data.movies, data.people),
    venues: Object.values(data.venues)
      .filter((venue) => showing.has(venue.id))
      .map(({ id, name }) => ({ id, name })),
  });
  vocabulary = {} as Vocabulary;
  for (const [kind, { filters }] of Object.entries(KINDS)) {
    const ids = new Set<FilterId>(filters);
    // Each kind is its own list of groups, so a search for a genre can't
    // land on a venue; the search keeps its index per list.
    vocabulary[kind as Kind] = groups
      .map((group) => group.filter((entry) => ids.has(entry.filterId)))
      .filter((group) => group.length > 0);
  }
  vocabularies.set(data, vocabulary);
  return vocabulary;
}

const normalise = (words: string) => normalizeToWords(words).join(" ");

const names = (entries: FilterSearchEntry[]) =>
  [...new Set(entries.map((entry) => entry.name))].join(", ");

/**
 * The one value `words` names, of `kind`. An exact name or alias wins (the
 * first listed, which for people and venues is the best represented); else
 * the only match; else an error naming the matches, or the values to choose
 * from.
 */
export function resolveValue(
  data: CinemaData,
  kind: Kind,
  words: string,
): FilterSearchEntry {
  const groups = getVocabulary(data)[kind];
  const { label } = KINDS[kind];
  const matches = searchFilterGroups(groups, words, {
    perGroup: 10,
    limit: 10,
  });
  const wanted = normalise(words);
  const exact = matches.find((entry) =>
    [entry.name, ...(entry.aliases ?? [])].some(
      (name) => normalise(name) === wanted,
    ),
  );
  if (exact) return exact;
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ResolveError(
      `"${words}" could be more than one ${label}: ${names(matches)}. ` +
        `Use the full name.`,
    );
  }
  const choices = LISTED.has(kind)
    ? ` Choose from: ${names(groups.flat())}.`
    : "";
  throw new ResolveError(
    `No ${label} called "${words}" has anything showing.${choices}`,
  );
}

/** Adds each value to the state, which matches a film with any of them. */
export function applyValues(
  state: FilterState,
  entries: FilterSearchEntry[],
): FilterState {
  const next = { ...state } as Record<string, unknown>;
  for (const { filterId, value } of entries) {
    const held = (next[filterId] as string[] | null) ?? [];
    if (!held.includes(value)) next[filterId] = [...held, value];
  }
  return next as FilterState;
}

export type Place = {
  /** As the site's place search writes it: `station:<slug>`, `venue:<id>`. */
  ref: string;
  /** What it's called: "King's Cross St. Pancras", "Rio Cinema". */
  label: string;
  point: Position;
};

/**
 * A London station or a venue, by name, as the site's place search takes
 * them. Not a postcode or a borough: the site has neither as a place.
 */
export async function resolvePlace(
  data: CinemaData,
  words: string,
): Promise<Place> {
  const stations = await loadStations();
  const wanted = normalise(words);
  const station = (s: Station): Place => ({
    ref: formatPlaceRef({ kind: "station", slug: s.slug }),
    label: s.name,
    point: { lat: s.lat, lon: s.lon },
  });

  const exactStation = stations.find((s) => normalise(s.name) === wanted);
  if (exactStation) return station(exactStation);

  let venue: FilterSearchEntry | undefined;
  let venueError: ResolveError | undefined;
  try {
    venue = resolveValue(data, "venue", words);
  } catch (error) {
    if (!(error instanceof ResolveError)) throw error;
    venueError = error;
  }
  const venuePlace: Place | undefined = venue && {
    ref: formatPlaceRef({ kind: "venue", id: venue.value }),
    label: data.venues[venue.value].name,
    point: data.venues[venue.value].geo,
  };
  if (venuePlace && normalise(venuePlace.label) === wanted) return venuePlace;

  // A run of a station's words: "kings cross" is King's Cross St. Pancras.
  const partial = stations.filter((s) =>
    ` ${normalise(s.name)} `.includes(` ${wanted} `),
  );
  const candidates = [
    ...partial.map(station),
    ...(venuePlace ? [venuePlace] : []),
  ];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ResolveError(
      `"${words}" could be more than one place: ` +
        `${candidates.map(({ label }) => label).join(", ")}. Use the full name.`,
    );
  }
  throw new ResolveError(
    `No London station or venue called "${words}". ` +
      `A place is a Tube, Overground, Elizabeth line or DLR station, or a ` +
      `venue; not a postcode or a borough.` +
      (venueError?.message.startsWith(`"${words}" could be`)
        ? ` ${venueError.message}`
        : ""),
  );
}
