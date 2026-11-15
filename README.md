# api-mcp

> **[Clusterflick](https://clusterflick.com)** is a free, open-source site
> listing every film showing in London, from 450+ venues in one search.
>
> This repository is the Cloudflare Worker that lets a reader's own AI
> assistant search those listings, as a remote
> [MCP](https://modelcontextprotocol.io) server. See the
> [Clusterflick organisation](https://github.com/clusterflick) for how the
> pieces fit together.

A reader asks their assistant "what horror is on near Brixton this weekend?",
and the assistant asks this Worker. The assistant does the thinking, so
Clusterflick pays for no model; each tool call is an ordinary Worker request.

**Not deployed yet.** Every tool is to need a reader signed in, and sign-in
(OAuth, with Firebase's email link as the login step) is the next piece of
work. Until then it runs locally, in its tests, and in `wrangler dev`.

## Tools

All read-only, over the listings the site publishes. Every value is plain
words, as a person would say them, resolved with the site's own vocabulary:
its labels and aliases ("subs" is Subtitles), the people credited on what's
showing, the venues showing it and London's stations. A value that names
nothing, or more than one thing, is an error saying which, never a filter left
off: a search quietly wider than the one asked for reads as an answer.

| Tool                | What it answers                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_screenings` | Films and events showing, soonest first, with their showings: by title, dates, time of day, near a station or venue, venues, event type, genre, director, cast, accessibility, occasion, format, festival, film club, minimum ratings and sold-out. |
| `get_film`          | One film by title (and year, when titles clash): its details and every showing from today.                                                                                                                                                          |
| `list_venues`       | The venues with something showing: all of them, or those near a place, nearest first.                                                                                                                                                               |

`search_screenings` starts from the site's own default search (films,
multiple films and short films over the next week, finished showings hidden),
so the same search finds the same films on both. Its answer says what was
searched, in the site's words, and links the same search on the site.

A place is a Tube, Overground, Elizabeth line or DLR station, or a venue, as
on the site. Not a postcode or a borough: the site has neither as a place.

Answers are JSON. Every film and venue carries its page on clusterflick.com
and every showing where to book it; times are London's. Only what helps
someone choose goes in: an answer lands whole in the assistant's context, so
a search returns 10 films with 3 showings each by default, about 10,000
characters, and says how many there are in all.

## The listings

The Worker reads the listings the site publishes, not the pipeline's combined
data: the site's build joins in the ratings and more. It finds them from
`https://clusterflick.com/data/current.json`, the one file there with a fixed
name, and reads them with `@clusterflick/catalogue`, the package the site
searches with, so a search here means what it means there.

- **Held in the isolate**, about 21MB parsed, and shared by every call it
  serves.
- **Checked every five minutes** (`CHECK_EVERY_MS`), with `current.json`
  fetched uncached. A new release is a new meta file named there; anything
  else costs that one small request.
- **Read again each London day**, since reading drops earlier days'
  performances.
- **The last good copy while the site is down**, retrying after a minute;
  with none held, a tool says it couldn't search, never that nothing is on.
- **Refused in a format it wasn't built for.** Both `current.json` and the
  meta file carry `DATA_FORMAT_VERSION`; a release in another means moving to
  the catalogue version that reads it.

Each load is logged as `{"event":"listings-loaded","meta","generatedAt",
"films","ms"}`, and each failure as `{"event":"listings-unavailable",
"message","held"}`.

## Requests

`/mcp` is the MCP endpoint, served by the MCP SDK's stateless handler: a fresh
server for each request, nothing shared between them. It speaks the
2026-07-28 protocol and the stateless form of the 2025 one. A request from a
browser page is refused unless the page is local (the MCP Inspector), so no
other site's page can use a reader's sign-in from their browser. Anything else
is a 404.

## Working on it

```bash
npm install
npm test          # Vitest in the Workers runtime
npm run lint      # tsc over the Worker and the tests
npm run dev       # http://localhost:8789/mcp
```

`npm run dev` reads the live site's listings. To try it with an assistant,
point one at the local address, for example
`claude mcp add --transport http clusterflick-local http://localhost:8789/mcp`,
or open it in the MCP Inspector (`npx @modelcontextprotocol/inspector`).

To read listings from somewhere else, such as a local copy of the site's
`public/data/`, set the origin: `npx wrangler dev --var
SITE_ORIGIN:http://127.0.0.1:8791`. The copy needs a `current.json` naming
its meta file, which the site's build writes.

## Licence

MIT, as the site.
