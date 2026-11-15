import { DATA_FORMAT_VERSION } from "@clusterflick/catalogue/data-format.mjs";
import {
  addLondonDays,
  getLondonMidnightTimestamp,
} from "@clusterflick/catalogue/utils/format-date";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { vi } from "vitest";
import { useFirebaseKeys } from "../src/authorize";
import { clearCapabilities } from "../src/capability";
import { clearAccessToken } from "../src/google-auth";
import worker from "../src/index";
import { clearListings } from "../src/listings";

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

export const PROJECT_ID = "clusterflick-com";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
export const MCP = "https://mcp.clusterflick.com";
export const UID = "uid1";

/** Firestore's documents, by path, as the fake serves them. */
export type Store = Record<string, Record<string, unknown>>;

/** A reader with the capability, as `grant-capability` writes it. */
export const granted = (uid = UID): Store => ({
  [`users/${uid}/meta/capabilities`]: {
    assistantAccess: { grantedAt: 1_794_700_000_000 },
  },
});

function encodeValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          encodeValue(v),
        ]),
      ),
    },
  };
}

export type SiteOptions = {
  pointer?: Record<string, unknown>;
  store?: Store;
  firestoreStatus?: number;
};

/**
 * The site, Google's token endpoint and Firestore, with every request each
 * was sent. `published` is a release, or a function returning one per
 * request.
 */
export function serveSite(
  published: Release | (() => Release) = release(),
  options: SiteOptions = {},
) {
  const { pointer, firestoreStatus = 200 } = options;
  // Read on every request, so a test can change it mid-way.
  const documents = () => options.store ?? granted();
  const requests: { url: string; cache?: string }[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ url: request.url, cache: init?.cache });

      if (url.href === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "google-token",
          expires_in: 3599,
        });
      }
      if (url.hostname === "firestore.googleapis.com") {
        if (firestoreStatus !== 200) {
          return new Response("unavailable", { status: firestoreStatus });
        }
        const path = decodeURIComponent(url.pathname).slice(
          `/v1/${ROOT}/`.length,
        );
        const data = documents()[path];
        if (!data) return Response.json({}, { status: 404 });
        return Response.json({
          name: `${ROOT}/${path}`,
          fields: (encodeValue(data).mapValue as { fields: unknown }).fields,
        });
      }

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
      const name = url.href.startsWith(`${ORIGIN}/data/`)
        ? url.href.slice(`${ORIGIN}/data/`.length)
        : undefined;
      if (name === undefined || !(name in files)) {
        return new Response("Not found", { status: 404 });
      }
      return Response.json(files[name]);
    });
  return { requests, spy };
}

/** The tests' stand-in for Google's keys, which `useFirebaseKeys` is given. */
const firebaseKeys = await generateKeyPair("RS256");
export const FIREBASE_TEST_KEYS = createLocalJWKSet({
  keys: [
    {
      ...(await exportJWK(firebaseKeys.publicKey)),
      kid: "firebase-test-key",
      alg: "RS256",
    },
  ],
});

/** A Firebase ID token for `uid`, as the site's sign-in gives one. */
export function signFirebaseToken(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: UID,
    iat: now - 60,
    exp: now + 3600,
    auth_time: now - 60,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "firebase-test-key" })
    .sign(firebaseKeys.privateKey);
}

/** The Worker, as Cloudflare calls it. */
export async function request(
  input: string | URL,
  init?: RequestInit,
  workerEnv: Env = env,
) {
  const ctx = createExecutionContext();
  // As Cloudflare hands it to a Worker; the tests have no `cf` to give.
  const incoming = new Request(input, init) as unknown as Request<
    unknown,
    IncomingRequestCfProperties
  >;
  const response = await worker.fetch(incoming, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * A reader's browser: the cookies the Worker sets, sent back to it, as the
 * OAuth library's binding cookies need.
 */
export class Browser {
  private cookies = new Map<string, string>();

  async fetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    }
    const response = await request(input, {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair.split("=");
      if (/Max-Age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    return response;
  }

  post(input: string, form: Record<string, string>) {
    return this.fetch(input, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }
}

export const REDIRECT_URI = "https://assistant.example/callback";

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** An assistant registering itself, as one without a metadata document does. */
export async function registerClient(name = "Test Assistant") {
  const response = await request(`${MCP}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) {
    throw new Error(
      `Registration failed: ${response.status} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Where the assistant sends the reader, with PKCE as MCP requires. */
export async function authorizeUrl(clientId: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const url = new URL(`${MCP}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "listings",
    state: "assistant-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${MCP}/mcp`,
  }).toString();
  return { url: url.toString(), verifier };
}

/** The consent form's handle, from the page. */
export const handleOf = (html: string) =>
  html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";

/**
 * Every step a reader takes to connect, up to the callback's answer: the
 * consent page, Allow, and /connect/ posting their sign-in.
 */
export async function signInSteps(
  browser = new Browser(),
  { idToken }: { idToken?: string } = {},
) {
  const clientId = await registerClient();
  const { url, verifier } = await authorizeUrl(clientId);
  const consent = await browser.fetch(url);
  const allowed = await browser.post(url, {
    handle: handleOf(await consent.text()),
    decision: "allow",
  });
  const connect = new URL(allowed.headers.get("Location")!);
  const state = connect.searchParams.get("state")!;
  const callback = await browser.post(`${MCP}/callback?state=${state}`, {
    idToken: idToken ?? (await signFirebaseToken()),
  });
  return { browser, clientId, verifier, connect, state, callback };
}

/** A reader connected: the assistant's access token. */
export async function signIn() {
  const { clientId, verifier, callback } = await signInSteps();
  const location = new URL(callback.headers.get("Location")!);
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`No code: ${location}`);
  const response = await request(`${MCP}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${MCP}/mcp`,
    }).toString(),
  });
  const tokens = (await response.json()) as { access_token: string };
  return tokens.access_token;
}

/** A client connected to the Worker as a signed-in reader's assistant would be. */
export async function connect(token?: string, workerEnv: Env = env) {
  const accessToken = token ?? (await signIn());
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${accessToken}`);
        return request(
          String(input instanceof Request ? input.url : input),
          { ...init, headers },
          workerEnv,
        );
      },
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

/**
 * Before each test: an isolate's state forgotten, the tests' Firebase keys,
 * and the per-reader limit always allowing, since every test signs in as the
 * same reader (its own test turns it down).
 */
export function resetWorker() {
  clearListings();
  clearCapabilities();
  clearAccessToken();
  useFirebaseKeys(FIREBASE_TEST_KEYS);
  vi.spyOn(env.CALL_LIMIT, "limit").mockResolvedValue({ success: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

/** Every logged line of `event`, parsed. */
export const logged = (spy: { mock: { calls: unknown[][] } }, event: string) =>
  spy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return undefined;
      }
    })
    .filter((line) => line?.event === event);
