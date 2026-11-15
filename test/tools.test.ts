import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearListings } from "../src/listings";
import { call, connect, ORIGIN, release, serveSite } from "./helpers";

beforeEach(() => {
  clearListings();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Film = {
  title: string;
  url: string;
  showings: { venue: string; bookingUrl: string; [key: string]: unknown }[];
  totalShowings: number;
};

const titles = (value: { films: Film[] }) =>
  value.films.map(({ title }) => title);

describe("the tools", () => {
  it("are the three, all read-only", async () => {
    serveSite();
    const { tools } = await (await connect()).listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "get_film",
      "list_venues",
      "search_screenings",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("search_screenings", () => {
  it("is the site's default search without input: films this week, soonest first", async () => {
    serveSite();
    const { value } = await call(await connect(), "search_screenings");
    // The Gleaners and I is next month; the quiz isn't a film.
    expect(titles(value)).toEqual(["Cléo from 5 to 7", "Halloween"]);
    expect(value.totalFilms).toBe(2);
    expect(value.onClusterflick).toBe(`${ORIGIN}/catalogue/`);
  });

  it("links each film to its page and each showing to its booking", async () => {
    serveSite();
    const { value } = await call(await connect(), "search_screenings", {
      title: "halloween",
    });
    const [film] = value.films as Film[];
    expect(film).toMatchObject({
      title: "Halloween",
      year: "1978",
      url: `${ORIGIN}/movies/m1/halloween`,
      genres: ["Horror"],
      directors: ["John Carpenter"],
      minutes: 91,
      ratings: { letterboxd: "3.9 out of 5" },
      totalShowings: 2,
    });
    expect(film.showings[0]).toMatchObject({
      venue: "Rio Cinema",
      venueUrl: `${ORIGIN}/venues/rio-cinema`,
      bookingUrl: "https://riocinema.org.uk/book/1",
      time: "19:30",
    });
    expect(film.showings[1]).toMatchObject({
      venue: "Prince Charles Cinema",
      listedAs: "Halloween + Q&A",
      accessibility: ["Subtitles"],
      occasions: ["Q&A"],
    });
  });

  it("reads values as a person says them", async () => {
    serveSite();
    const client = await connect();
    const subtitled = await call(client, "search_screenings", {
      accessibility: ["subs"],
    });
    expect(titles(subtitled.value)).toEqual(["Halloween"]);
    expect((subtitled.value.films[0] as Film).showings).toHaveLength(1);

    const varda = await call(client, "search_screenings", {
      directors: ["agnes varda"],
      to: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
    });
    expect(titles(varda.value)).toEqual([
      "Cléo from 5 to 7",
      "The Gleaners and I",
    ]);

    const quizzes = await call(client, "search_screenings", {
      categories: ["quizzes"],
    });
    expect(titles(quizzes.value)).toEqual(["Horror Movie Quiz"]);
  });

  it("finds what's near a station", async () => {
    serveSite();
    const { value } = await call(await connect(), "search_screenings", {
      near: "Dalston Kingsland",
      withinMiles: 1,
    });
    expect(titles(value)).toEqual(["Halloween"]);
    expect((value.films[0] as Film).showings.map(({ venue }) => venue)).toEqual(
      ["Rio Cinema"],
    );
    expect(value.searched).toContain("Dalston Kingsland");
  });

  it.each([
    [
      { genres: ["westerns"] },
      'No genre called "westerns" has anything showing. Choose from: Documentary, Drama, Horror',
    ],
    [
      { venues: ["cinema"] },
      '"cinema" could be more than one venue: Rio Cinema, Prince Charles Cinema. Use the full name.',
    ],
    [{ near: "Dalston" }, '"Dalston" could be more than one place'],
    [{ near: "E8 2PB" }, "not a postcode or a borough"],
    [{ near: "Bank", venues: ["Rio"] }, "not both"],
    [{ from: "2026-02-30" }, "isn't a date"],
  ])("refuses %o, saying why", async (input, message) => {
    serveSite();
    const { error } = await call(await connect(), "search_screenings", input);
    expect(error).toContain(message);
  });
});

describe("get_film", () => {
  it("is the film's details and every showing from today", async () => {
    serveSite();
    const { value } = await call(await connect(), "get_film", {
      title: "the gleaners and i",
    });
    expect(value).toMatchObject({
      title: "The Gleaners and I",
      directors: ["Agnès Varda"],
      totalShowings: 1,
    });
    expect(value.showings[0].venue).toBe("BFI Southbank");
  });

  it("asks which film, when a title names several", async () => {
    const published = release();
    published.chunk.m3.title = "Halloween";
    published.chunk.m3.year = "2018";
    serveSite(published);
    const client = await connect();
    expect((await call(client, "get_film", { title: "Halloween" })).error).toBe(
      '"Halloween" could be more than one film showing: Halloween (1978); Halloween (2018). Give the full title, or the year.',
    );
    const { value } = await call(client, "get_film", {
      title: "Halloween",
      year: "2018",
    });
    expect(value.year).toBe("2018");
  });
});

describe("list_venues", () => {
  it("lists those near a place, nearest first, with how far", async () => {
    serveSite();
    const { value } = await call(await connect(), "list_venues", {
      near: "Leicester Square",
      withinMiles: 2,
    });
    expect(value.near).toBe("Leicester Square");
    expect(value.venues.map(({ name }: { name: string }) => name)).toEqual([
      "Prince Charles Cinema",
      "BFI Southbank",
    ]);
    expect(value.venues[0]).toMatchObject({
      url: `${ORIGIN}/venues/prince-charles-cinema`,
      website: "https://princecharlescinema.com",
      kind: "cinema",
    });
    expect(value.venues[0].miles).toBeLessThan(value.venues[1].miles);
  });
});
