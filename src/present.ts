import type { ReaderLists } from "./reader-lists";
import { FORMAT_GROUPS } from "@clusterflick/catalogue/filters";
import type {
  AccessibilityFeature,
  CinemaData,
  IncludedMovie,
  Movie,
  MoviePerformance,
  OccasionType,
  Venue,
} from "@clusterflick/catalogue/types";
import { ACCESSIBILITY_LABELS } from "@clusterflick/catalogue/utils/accessibility-labels";
import { getIncludedListings } from "@clusterflick/catalogue/utils/get-included-listings";
import { getMovieUrl } from "@clusterflick/catalogue/utils/get-movie-url";
import { getVenueUrl } from "@clusterflick/catalogue/utils/get-venue-url";
import { OCCASION_LABELS } from "@clusterflick/catalogue/utils/occasion-labels";

/**
 * What a tool hands the assistant: plain words and London times, every film
 * and venue with its page on the site, and every showing with where to book
 * it. Only what helps someone choose: a result reaches the assistant's
 * context whole, so it carries no ids, posters or raw scores.
 */

const LONDON = "Europe/London";

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** A performance's time, in London: "2026-11-15", "19:30", "Sunday 15 November". */
export function londonTime(time: number) {
  return {
    date: dateFormat.format(time),
    time: timeFormat.format(time),
    day: dayFormat.format(time),
  };
}

function formatLabels(performance: MoviePerformance): string[] {
  const labels: string[] = [];
  for (const group of FORMAT_GROUPS) {
    const value = performance.format?.[group.key];
    if (value === undefined || value === group.defaultValue) continue;
    const option = group.options.find((o) => o.value === value);
    if (option) labels.push(option.label);
  }
  return labels;
}

function trueKeys<T extends string>(record: Partial<Record<T, unknown>>) {
  return (Object.keys(record) as T[]).filter((key) => record[key]);
}

/**
 * The reader's lists, when this connection may see them, to mark what's on
 * them: only ever `true`, so an answer without lists reads the same.
 */
export type Marks = ReaderLists | null;

export function presentPerformance(
  data: CinemaData,
  movie: Movie,
  performance: MoviePerformance,
  origin: string,
  marks: Marks = null,
) {
  const showing = movie.showings[performance.showingId];
  const venue = data.venues[showing.venueId];
  const accessibility = trueKeys<AccessibilityFeature>(
    performance.accessibility ?? {},
  ).map((feature) => ACCESSIBILITY_LABELS[feature]);
  const occasions = trueKeys<OccasionType>(performance.occasions ?? {}).map(
    (kind) => OCCASION_LABELS[kind],
  );
  const format = formatLabels(performance);
  return {
    ...londonTime(performance.time),
    venue: venue.name,
    venueUrl: origin + getVenueUrl(venue),
    ...(marks?.venues.has(venue.id) ? { yourVenue: true } : {}),
    bookingUrl: performance.bookingUrl,
    // The venue's own title, when it isn't the film's: "Halloween + Q&A".
    ...(showing.title && showing.title !== movie.title
      ? { listedAs: showing.title }
      : {}),
    ...(performance.screen ? { screen: performance.screen } : {}),
    ...(performance.notes ? { notes: performance.notes } : {}),
    ...(accessibility.length > 0 ? { accessibility } : {}),
    ...(occasions.length > 0 ? { occasions } : {}),
    ...(format.length > 0 ? { format } : {}),
    ...(performance.status?.soldOut ? { soldOut: true } : {}),
  };
}

function ratings(movie: Movie) {
  const result: Record<string, string> = {};
  const letterboxd = movie.letterboxd?.rating;
  if (typeof letterboxd === "number") {
    result.letterboxd = `${letterboxd.toFixed(1)} out of 5`;
  }
  const imdb = movie.imdb?.rating;
  if (typeof imdb === "number") result.imdb = `${imdb.toFixed(1)} out of 10`;
  const tomatometer = movie.rottenTomatoes?.critics?.all?.score;
  if (typeof tomatometer === "number") {
    result.rottenTomatoes = `${tomatometer}%`;
  }
  return result;
}

const namesOf = (
  ids: string[] | undefined,
  lookup: Record<string, { name: string }>,
  limit = Infinity,
) =>
  (ids ?? [])
    .map((id) => lookup[id]?.name)
    .filter((name): name is string => Boolean(name))
    .slice(0, limit);

/**
 * A film a multi-film event screens: its title and year, and its page when it
 * is also listed on its own. A film with no listing of its own has no page,
 * so it carries no `url`.
 */
export function presentIncludedFilm(
  film: IncludedMovie,
  listing: Movie | undefined,
  origin: string,
  marks: Marks = null,
) {
  return {
    title: film.title,
    ...(film.year ? { year: film.year } : {}),
    ...(listing ? { url: origin + getMovieUrl(listing) } : {}),
    ...(marks?.watchlist.has(film.id) ? { onWatchlist: true } : {}),
    ...(marks?.seen.has(film.id) ? { seen: true } : {}),
  };
}

/** A film's own details, without its showings. */
export function presentFilm(
  data: CinemaData,
  movie: Movie,
  origin: string,
  {
    detailed = false,
    marks = null,
  }: { detailed?: boolean; marks?: Marks } = {},
) {
  const genres = namesOf(movie.genres, data.genres).filter(
    (name) => name !== "Uncategorised",
  );
  const directors = namesOf(movie.directors, data.people);
  const filmRatings = ratings(movie);
  return {
    title: movie.title,
    ...(movie.year ? { year: movie.year } : {}),
    url: origin + getMovieUrl(movie),
    ...(marks?.watchlist.has(movie.id) ? { onWatchlist: true } : {}),
    ...(marks?.seen.has(movie.id) ? { seen: true } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(directors.length > 0 ? { directors } : {}),
    ...(movie.duration ? { minutes: Math.round(movie.duration / 60_000) } : {}),
    ...(movie.classification ? { certificate: movie.classification } : {}),
    ...(Object.keys(filmRatings).length > 0 ? { ratings: filmRatings } : {}),
    ...(movie.includedMovies?.length
      ? {
          screens: getIncludedListings(movie, data.movies).map(
            ({ film, listing }) =>
              presentIncludedFilm(film, listing, origin, marks),
          ),
        }
      : {}),
    ...(detailed
      ? {
          ...(movie.originalTitle
            ? { originalTitle: movie.originalTitle }
            : {}),
          ...(movie.alternativeTitles?.length
            ? { alternativeTitles: movie.alternativeTitles }
            : {}),
          ...(movie.overview ? { overview: movie.overview } : {}),
          cast: namesOf(movie.actors, data.people, 10),
          ...(movie.youtubeTrailer
            ? {
                trailer: `https://www.youtube.com/watch?v=${movie.youtubeTrailer}`,
              }
            : {}),
        }
      : {}),
  };
}

/** A film's performances, soonest first: the first `limit` of them. */
export function presentPerformances(
  data: CinemaData,
  movie: Movie,
  origin: string,
  limit: number,
  marks: Marks = null,
) {
  const sorted = [...movie.performances].sort((a, b) => a.time - b.time);
  return {
    showings: sorted
      .slice(0, limit)
      .map((performance) =>
        presentPerformance(data, movie, performance, origin, marks),
      ),
    totalShowings: sorted.length,
  };
}

export function presentVenue(
  venue: Venue,
  origin: string,
  marks: Marks = null,
) {
  return {
    name: venue.name,
    url: origin + getVenueUrl(venue),
    ...(marks?.venues.has(venue.id) ? { yourVenue: true } : {}),
    address: venue.address,
    website: venue.url,
    kind:
      venue.programming === "cinema"
        ? "cinema"
        : venue.programming === "venue"
          ? "arts venue"
          : "hosts occasional screenings",
  };
}
