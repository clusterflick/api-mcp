import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_TTL_MS,
  clearCapabilities,
  hasAssistantAccess,
} from "../src/capability";
import {
  authorizeUrl,
  Browser,
  call,
  connect,
  granted,
  handleOf,
  logged,
  MCP,
  REDIRECT_URI,
  registerClient,
  request,
  resetWorker,
  serveSite,
  signFirebaseToken,
  signIn,
  signInSteps,
  UID,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

beforeEach(() => {
  ({ log } = resetWorker());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an assistant finding how to sign in", () => {
  it("is told where by the endpoint, as MCP's discovery expects", async () => {
    serveSite();
    const response = await request(`${MCP}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"`,
    );
    const metadata = await (
      await request(`${MCP}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    expect(metadata).toMatchObject({
      resource: `${MCP}/mcp`,
      authorization_servers: [MCP],
      scopes_supported: ["listings"],
    });
  });

  it("finds both ways to identify itself", async () => {
    serveSite();
    const server = (await (
      await request(`${MCP}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(server.registration_endpoint).toBe(`${MCP}/oauth/register`);
    expect(server.client_id_metadata_document_supported).toBe(true);
  });
});

describe("the consent page", () => {
  it("names the assistant, escaped, and where access goes", async () => {
    serveSite();
    const clientId = await registerClient('<script>alert("x")</script>');
    const { url } = await authorizeUrl(clientId);
    const response = await new Browser().fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("<strong>assistant.example</strong>");
    expect(html).toContain("registered itself");
    expect(html).not.toContain("an app on this computer");
  });

  it("says in words when access goes to an app on this computer", async () => {
    serveSite();
    const local = "http://localhost:33418/callback";
    const { url } = await authorizeUrl(
      await registerClient("Claude Code", local),
      local,
    );
    const html = await (await new Browser().fetch(url)).text();
    expect(html).toContain(
      "<strong>an app on this computer</strong> (localhost)",
    );
    expect(html).toContain("Only continue if you started connecting from it");
  });

  it("sends the reader to the site to sign in when they allow it", async () => {
    serveSite();
    const { connect: page } = await signInSteps();
    expect(`${page.origin}${page.pathname}`).toBe(
      "https://clusterflick.com/connect/",
    );
    expect(page.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sends the reader back to the assistant, refused, when they deny it", async () => {
    serveSite();
    const browser = new Browser();
    const { url } = await authorizeUrl(await registerClient());
    const consent = await browser.fetch(url);
    const denied = await browser.post(url, {
      handle: handleOf(await consent.text()),
      decision: "deny",
    });
    const back = new URL(denied.headers.get("Location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("assistant-state");
  });

  it("can't be answered from another browser", async () => {
    serveSite();
    const { url } = await authorizeUrl(await registerClient());
    const consent = await new Browser().fetch(url);
    const answered = await new Browser().post(url, {
      handle: handleOf(await consent.text()),
      decision: "allow",
    });
    expect(answered.status).toBe(400);
    expect(await answered.text()).toContain("opened in a different browser");
  });
});

describe("signing in at the callback", () => {
  it("connects a reader with the capability, and sends them back with a code", async () => {
    serveSite();
    const { callback } = await signInSteps();
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(logged(log, "mcp-sign-in")).toEqual([
      { event: "mcp-sign-in", state: "connected", uid: UID },
    ]);
  });

  it("tells a reader without the capability, here, with the way back", async () => {
    serveSite(undefined, { store: {} });
    const { callback } = await signInSteps();
    expect(callback.status).toBe(403);
    const html = await callback.text();
    expect(html).toContain("AI assistant access is by invitation");
    const back = new URL(
      html.match(/href="([^"]+)"/)![1].replaceAll("&#38;", "&"),
    );
    expect(back.searchParams.get("error")).toBe("access_denied");
  });

  it.each([
    [
      "from another project",
      {
        aud: "another-project",
        iss: "https://securetoken.google.com/another-project",
      },
    ],
    ["with an unverified address", { email_verified: false }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])("refuses a sign-in %s", async (_, claims) => {
    serveSite();
    const { callback } = await signInSteps(new Browser(), {
      idToken: await signFirebaseToken(claims),
    });
    const back = new URL(callback.headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("works once", async () => {
    serveSite();
    const { browser, state } = await signInSteps();
    const again = await browser.post(`${MCP}/callback?state=${state}`, {
      idToken: await signFirebaseToken(),
    });
    expect(again.status).toBe(400);
  });

  it("says so when Firestore can't be asked, rather than guessing", async () => {
    serveSite(undefined, { firestoreStatus: 503 });
    const { callback } = await signInSteps();
    expect(callback.status).toBe(503);
    expect(await callback.text()).toContain("finish signing you in");
  });
});

describe("a connected assistant", () => {
  it("searches as the reader, each call logged without what was searched", async () => {
    serveSite();
    const { value } = await call(await connect(), "search_screenings", {
      genres: ["horror"],
    });
    expect(value.totalFilms).toBe(1);
    const [line] = logged(log, "mcp-call");
    expect(line).toMatchObject({
      uid: UID,
      tool: "search_screenings",
      outcome: "answered",
    });
    expect(JSON.stringify(line)).not.toContain("horror");
  });

  it("stops within five minutes of the capability being revoked", async () => {
    let store = granted();
    serveSite(undefined, {
      get store() {
        return store;
      },
    });
    const token = await signIn();
    const client = await connect(token);
    store = {};
    // Remembered for five minutes: still answering.
    expect((await call(client, "list_venues")).value).toBeDefined();
    clearCapabilities();
    await expect(call(client, "list_venues")).rejects.toThrow();
    expect(logged(log, "mcp-call").at(-1)).toMatchObject({
      outcome: "not-permitted",
    });
  });

  it("is limited per reader", async () => {
    serveSite();
    const token = await signIn();
    const client = await connect(token);
    vi.mocked(env.CALL_LIMIT.limit).mockResolvedValue({ success: false });
    await expect(call(client, "list_venues")).rejects.toThrow();
    expect(env.CALL_LIMIT.limit).toHaveBeenLastCalledWith({ key: UID });
  });

  it("refuses a browser page from another site", async () => {
    serveSite();
    const token = await signIn();
    const response = await request(`${MCP}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("the capability", () => {
  it("is remembered for five minutes, then asked again", async () => {
    const { requests } = serveSite();
    const firestore = () =>
      requests.filter(({ url }) => url.includes("firestore")).length;
    const now = Date.now();
    expect(await hasAssistantAccess(env, UID, { now })).toBe(true);
    await hasAssistantAccess(env, UID, { now: now + CAPABILITY_TTL_MS - 1 });
    expect(firestore()).toBe(1);
    await hasAssistantAccess(env, UID, { now: now + CAPABILITY_TTL_MS });
    expect(firestore()).toBe(2);
    await hasAssistantAccess(env, UID, { now, fresh: true });
    expect(firestore()).toBe(3);
  });

  it("is never looked up for something that isn't a uid", async () => {
    serveSite();
    await expect(hasAssistantAccess(env, "../../secrets")).rejects.toThrow(
      "Not a uid",
    );
  });
});
