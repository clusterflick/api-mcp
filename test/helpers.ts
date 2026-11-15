import { DATA_FORMAT_VERSION } from "@clusterflick/catalogue/data-format.mjs";
import {
  addLondonDays,
  getLondonMidnightTimestamp,
} from "@clusterflick/catalogue/utils/format-date";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";
import { handleRequest } from "../src/handler";

export const ORIGIN = "https://clusterflick.com";
const HOUR = 3_600_000;

/** `hours` into the London day `days` from today. */
export const at = (days: number, hours: number) =>
  addLondonDays(getLondonMidnightTimestamp(), days) + hours * HOUR;

export const META = "data.meta.0123456789.json";
const CHUNK = "data.0.abcdefabcd.json";

/**
 * A release as the site's build publishes it: no record carries its id, which
 * is its key.
 */
export function release() {
  const meta = {
    formatVersion: DATA_FORMAT_VERSION,
    generatedAt: "2026-11-15T06:00:00Z",
    filenames: [CHUNK],
    mapping: { "0": ["m1", "m2", "m3", "m4"] },
    genres: {
      "27": { name: "Horror" },
      "18": { name: "Drama" },
      "99": { name: "Documentary" },
    },
    people: {
      p1: { name: "Agnès Varda" },
      p2: { name: "Jamie Lee Curtis" },
      p3: { name: "John Carpenter" },
    },
    venues: {
      rio: {
        name: "Rio Cinema",
        url: "https://riocinema.org.uk",
        address: "107 Kingsland High St, London E8 2PB",
        geo: { lat: 51.5487, lon: -0.0752 },
        programming: "cinema",
        type: "Cinema",
        structure: "solo",
        socials: {},
      },
      pcc: {
        name: "Prince Charles Cinema",
        url: "https://princecharlescinema.com",
        address: "7 Leicester Pl, London WC2H 7BY",
        geo: { lat: 51.5115, lon: -0.1302 },
        programming: "cinema",
        type: "Cinema",
        structure: "solo",
        socials: {},
      },
      bfi: {
        name: "BFI Southbank",
        url: "https://whatson.bfi.org.uk",
        address: "Belvedere Rd, London SE1 8XT",
        geo: { lat: 51.5069, lon: -0.115 },
        programming: "cinema",
        type: "Cinema",
        structure: "solo",
        socials: {},
      },
    },
    collections: {},
  };
  const chunk = {
    m1: {
      title: "Halloween",
      normalizedTitle: "halloween",
      year: "1978",
      duration: 91 * 60_000,
      genres: ["27"],
      directors: ["p3"],
      actors: ["p2"],
      letterboxd: { rating: 3.9, reviews: 500_000 },
      showings: {
        h1: {
          category: "movie",
          url: "https://riocinema.org.uk/halloween",
          venueId: "rio",
        },
        h2: {
          category: "movie",
          url: "https://princecharlescinema.com/halloween",
          venueId: "pcc",
          title: "Halloween + Q&A",
        },
      },
      performances: [
        {
          showingId: "h1",
          time: at(1, 19.5),
          bookingUrl: "https://riocinema.org.uk/book/1",
        },
        {
          showingId: "h2",
          time: at(2, 20),
          bookingUrl: "https://princecharlescinema.com/book/2",
          accessibility: { subtitled: true },
          occasions: { qAndA: true },
        },
      ],
    },
    m2: {
      title: "Cléo from 5 to 7",
      normalizedTitle: "cleo from 5 to 7",
      year: "1962",
      genres: ["18"],
      directors: ["p1"],
      showings: {
        c1: {
          category: "movie",
          url: "https://whatson.bfi.org.uk/cleo",
          venueId: "bfi",
        },
      },
      performances: [
        {
          showingId: "c1",
          time: at(1, 14),
          bookingUrl: "https://whatson.bfi.org.uk/book/3",
          format: { source: "35mm" },
        },
      ],
    },
    m3: {
      title: "The Gleaners and I",
      normalizedTitle: "gleaners and i",
      year: "2000",
      genres: ["99"],
      directors: ["p1"],
      showings: {
        g1: {
          category: "movie",
          url: "https://whatson.bfi.org.uk/gleaners",
          venueId: "bfi",
        },
      },
      performances: [
        {
          showingId: "g1",
          time: at(30, 18),
          bookingUrl: "https://whatson.bfi.org.uk/book/4",
        },
      ],
    },
    m4: {
      title: "Horror Movie Quiz",
      normalizedTitle: "horror movie quiz",
      isUnmatched: true,
      showings: {
        q1: {
          category: "quiz",
          url: "https://princecharlescinema.com/quiz",
          venueId: "pcc",
        },
      },
      performances: [
        {
          showingId: "q1",
          time: at(1, 21),
          bookingUrl: "https://princecharlescinema.com/book/5",
        },
      ],
    },
  };
  return { meta, chunk };
}

type Release = ReturnType<typeof release>;

/**
 * The site, serving `published` (a release, or a function returning one per
 * request), with every request it was asked for.
 */
export function serveSite(
  published: Release | (() => Release) = release(),
  { pointer }: { pointer?: Record<string, unknown> } = {},
) {
  const requests: { url: string; cache?: string }[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({ url, cache: init?.cache });
      const { meta, chunk } =
        typeof published === "function" ? published() : published;
      const files: Record<string, unknown> = {
        "current.json": pointer ?? {
          formatVersion: meta.formatVersion,
          meta: META,
          generatedAt: meta.generatedAt,
        },
        [typeof pointer?.meta === "string" ? pointer.meta : META]: meta,
        [CHUNK]: chunk,
      };
      const name = url.startsWith(`${ORIGIN}/data/`)
        ? url.slice(`${ORIGIN}/data/`.length)
        : undefined;
      if (name === undefined || !(name in files)) {
        return new Response("Not found", { status: 404 });
      }
      return Response.json(files[name]);
    });
  return { requests, spy };
}

/** A client connected to the Worker, as an assistant would be. */
export async function connect() {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => handleRequest(new Request(input, init)),
    }),
  );
  return client;
}

/** A tool's answer, parsed, or its refusal's words. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return result.isError
    ? { error: first.text }
    : { value: JSON.parse(first.text) };
}
