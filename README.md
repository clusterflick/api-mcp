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

Every tool needs a reader signed in, with `assistantAccess`: a capability
the site grants one account at a time, and invitation-only for now. See
[Sign-in](#sign-in).

It's at `https://mcp.clusterflick.com/mcp`.

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

**The reader's lists**, when they allowed them (below): every film on their
watchlist or Seen list is marked `onWatchlist` or `seen`, and every showing or
venue among their venues `yourVenue`. `search_screenings` can leave out what
they've seen (`hideSeen`), and keep to their watchlist (`watchlistOnly`) or
their venues (`myVenuesOnly`, with `near` those of them near it). An empty
list is refused rather than searched, since an empty selection is no filter
at all; a connection without the lists says how to allow them.

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

## Sign-in

OAuth 2.1, as MCP's 2026-07-28 authorization spec has it, from Cloudflare's
`@cloudflare/workers-oauth-provider`: it serves the discovery documents
(`/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`), client registration
(`/oauth/register`), the token endpoint (`/oauth/token`), and answers `/mcp`
without a valid token with the `401` that starts an assistant signing in. An
assistant identifies itself with a Client ID Metadata Document, which the spec
prefers, or by registering.

What it leaves to us is `src/authorize.ts`:

1. **`GET /authorize`** asks the reader whether to let the assistant search
   as them, and whether it may see their lists (a tick-box, ticked to start
   with), naming it (escaped: an assistant chooses its own name), saying
   where access goes, warning when that's an app on their computer, and
   giving a metadata document's domain. It can't be framed.
2. **`POST /authorize`**: Deny goes back to the assistant with
   `access_denied`. Allow goes to the site's `/connect/` (`CONNECT_URL`), since
   Firebase's sign-in lives there, with the `state` the library made.
3. **`POST /callback?state=…`**: `/connect/` posts the reader's Firebase ID
   token (`idToken`). It's checked as api-profiles checks one, then the
   account's `assistantAccess` is read fresh from Firestore. With it, the
   reader goes back to the assistant with a code, signed in as their uid
   (the token's `props`). Without it, they're told here, with a link back
   that tells the assistant only `access_denied`.

The library ties each step to the browser that started it with a cookie, and
each works once, for ten minutes: a reader fetching their sign-in email has
that long, and must open it in the same browser.

**Scopes** (`src/scopes.ts`): every connection has `listings`; `lists`, the
watchlist, Seen list and venues, is the reader's to untick. A connection keeps
the scopes it was given, so one made before a scope existed, or with it
unticked, lacks it until the reader connects it again; `/connections` returns
each connection's scopes for /personalise to say so. The lists are read fresh
on each call that may use them (`src/reader-lists.ts`): one read of
`users/{uid}`, masked to `watchlist`, `seen` and `favouriteVenues`, never
remembered, so a film marked seen a minute ago isn't suggested. If that ever
costs too much, the site already tells api-profiles when a reader's lists
change, and could tell this Worker too. If they can't be read, the call is
refused rather than answered without them. `src/lists.ts` is a copy of
api-profiles' too.

**After signing in**, an access token lasts an hour and is refreshed; a
connection lasts while it's used and ends after 30 days without a call. Every
call to `/mcp` then:

- **Is limited per reader**, 60 a minute (`CALL_LIMIT`), keyed on their uid.
- **Checks the capability again**, remembered for five minutes
  (`CAPABILITY_TTL_MS`), so revoking it stops their assistant within five
  minutes. Firestore unreachable is a 503, never a guess either way.
- **Is logged** as `{"event":"mcp-call","uid","tool","outcome","lists","ms"}`,
  never with what was searched for or what's on the reader's lists, only
  whether they were read. Sign-ins are logged as `mcp-sign-in`.

Firestore is read as this Worker's own service account, with Cloud Datastore
Viewer and nothing else. `src/auth.ts`, `src/google-auth.ts` and
`src/firestore.ts` are copies of api-profiles' until the Workers share a
package, which is to be the first job of alerts.

**A reader's connections**, for /personalise to list and disconnect
(`src/connections.ts`): `GET /connections` lists the assistants they've
connected, by name (a metadata document's domain beside it), newest first;
`DELETE /connections/<id>` disconnects one, and its tokens go with it. Both
take the reader's Firebase ID token, answer the site's origin
(`CONNECT_URL`'s) for CORS, and skip the capability, so a reader whose access
was revoked can still see and remove what's connected. When it was last used
isn't kept: it would be a write on every call.

A daily cron sweeps the OAuth store (`OAUTH_KV`) for what KV's own expiry
leaves.

## Requests

`/mcp` is the MCP endpoint, served by the MCP SDK's stateless handler: a fresh
server for each request, built for the reader making it. It speaks the
2026-07-28 protocol and the stateless form of the 2025 one. A request from a
browser page is refused unless the page is local (the MCP Inspector).

## Working on it

```bash
npm install
npm test          # Vitest in the Workers runtime
npm run lint      # tsc over the Worker and the tests
npm run dev       # http://localhost:8789/mcp
```

`npm test` runs the whole sign-in in the Workers runtime against fakes of
the site, Google and Firestore, with a Firebase key made up for the tests;
its bindings are pinned in `vitest.config.ts`, so nothing in `.dev.vars`
reaches it.

To sign in for real, locally:

1. Copy `.dev.vars.example` to `.dev.vars`, with this Worker's service
   account key, and the localhost addresses it gives.
2. Run the site's `next dev` with `NEXT_PUBLIC_MCP_ORIGIN=http://localhost:8789`,
   so its `/connect/` posts here.
3. `npm run dev`, then point an assistant at `http://localhost:8789/mcp`, for
   example `claude mcp add --transport http clusterflick-local
http://localhost:8789/mcp`. It reads the live site's listings, and the
   live project's capabilities: sign in as an account with
   `assistantAccess`.

To read listings from somewhere else, such as a local copy of the site's
`public/data/`, set the origin: `npx wrangler dev --var
SITE_ORIGIN:http://127.0.0.1:8791`. The copy needs a `current.json` naming
its meta file, which the site's build writes.

## Deployment

`.github/workflows/deploy.yml` lints and tests every push and pull request,
and deploys on pushes to `main`. The service account key is a secret stored
on the Worker: it persists across deploys and never goes in the repo or CI.

The site's `/connect/` must be live before the Worker is any use: without it,
every sign-in ends at a 404.

`mcp.clusterflick.com` is a custom domain (`wrangler.jsonc`'s `routes`):
Cloudflare made its DNS record and certificate on the first deploy.

### The service account

In the Google Cloud console for `clusterflick-com`, under IAM → Service
accounts, there's one for this Worker alone, `api-mcp`, with the **Cloud
Datastore Viewer** role (`roles/datastore.viewer`) and nothing else. That
role reads every document in the project, since Firestore has no narrower IAM
role; what this Worker reads is limited by its code, to a reader's
capabilities.

### First deploy

As api-profiles' was: CI can't create a Worker whose `wrangler.jsonc`
requires a secret, and `wrangler secret put` only works on one that exists.
So the first deploy was from a machine with the key, creating the Worker and
its secret together, from a file holding only the secret (`.dev.vars` also
points the Worker at localhost):

```sh
grep "^FIREBASE_SERVICE_ACCOUNT=" .dev.vars > /tmp/mcp.env
npx wrangler deploy --secrets-file /tmp/mcp.env
rm /tmp/mcp.env
```

The OAuth store was created first, and its id is in `wrangler.jsonc`:
`npx wrangler kv namespace create OAUTH_KV`.

CI deploys with the repository secrets `CLOUDFLARE_API_TOKEN` (the "Edit
Cloudflare Workers" template, scoped to the account and the
`clusterflick.com` zone) and `CLOUDFLARE_ACCOUNT_ID`.

### Rotating the key

Create a new key for the service account, then:

```sh
node -e 'process.stdout.write(JSON.stringify(require("./new-key.json")))' | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

and delete the old key in the console.

## Licence

MIT, as the site.
