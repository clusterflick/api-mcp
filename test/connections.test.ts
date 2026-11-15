import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  call,
  connect,
  granted,
  logged,
  MCP,
  ORIGIN,
  request,
  resetWorker,
  serveSite,
  signFirebaseToken,
  signIn,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

beforeEach(() => {
  ({ log } = resetWorker());
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Connection = {
  id: string;
  name: string;
  domain?: string;
  connectedAt: number;
};

/** A reader of the test's own: the OAuth store lasts across tests. */
let uid = "";
let readers = 0;

beforeEach(() => {
  uid = `connections${++readers}`;
  serveSite(undefined, { store: granted(uid) });
});

/** The reader's connections, as /personalise asks for them. */
async function listConnections(claims: Record<string, unknown> = {}) {
  const response = await request(`${MCP}/connections`, {
    headers: {
      Authorization: `Bearer ${await signFirebaseToken({ sub: uid, ...claims })}`,
      Origin: ORIGIN,
    },
  });
  return {
    response,
    connections: response.ok
      ? ((await response.json()) as { connections: Connection[] }).connections
      : [],
  };
}

describe("a reader's connections", () => {
  it("lists each connected assistant by name, with when", async () => {
    const before = Date.now();
    await signIn(uid);
    const { response, connections } = await listConnections();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ name: "Test Assistant" });
    expect(connections[0].domain).toBeUndefined();
    // Milliseconds, as the site's dates are.
    expect(connections[0].connectedAt).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) * 1000,
    );
    expect(connections[0].connectedAt).toBeLessThanOrEqual(Date.now());
  });

  it("are only ever the reader's own", async () => {
    await signIn(uid);
    const { connections } = await listConnections({ sub: "someoneElse" });
    expect(connections).toEqual([]);
  });

  it("disconnect one, and its assistant is refused from then on", async () => {
    const token = await signIn(uid);
    const client = await connect(token);
    expect((await call(client, "list_venues")).value).toBeDefined();
    const [{ id }] = (await listConnections()).connections;

    const removed = await request(`${MCP}/connections/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: uid })}`,
        Origin: ORIGIN,
      },
    });
    expect(removed.status).toBe(204);
    expect((await listConnections()).connections).toEqual([]);
    await expect(call(client, "list_venues")).rejects.toThrow();
    expect(logged(log, "mcp-disconnect")).toHaveLength(1);
  });

  it("disconnect all of them, as deleting the account does", async () => {
    const first = await connect(await signIn(uid));
    const second = await connect(await signIn(uid));
    expect((await listConnections()).connections).toHaveLength(2);

    const removed = await request(`${MCP}/connections`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: uid })}`,
        Origin: ORIGIN,
      },
    });
    expect(removed.status).toBe(204);
    expect(removed.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect((await listConnections()).connections).toEqual([]);
    await expect(call(first, "list_venues")).rejects.toThrow();
    await expect(call(second, "list_venues")).rejects.toThrow();
    expect(logged(log, "mcp-disconnect")[0]).toMatchObject({
      all: true,
      count: 2,
    });
  });

  it("disconnect all of them, even when there are none", async () => {
    const removed = await request(`${MCP}/connections`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: uid })}`,
      },
    });
    expect(removed.status).toBe(204);
  });

  it("can't disconnect all of another reader's", async () => {
    await signIn(uid);
    await request(`${MCP}/connections`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: "someoneElse" })}`,
      },
    });
    expect((await listConnections()).connections).toHaveLength(1);
  });

  it("can't disconnect another reader's", async () => {
    await signIn(uid);
    const [{ id }] = (await listConnections()).connections;
    await request(`${MCP}/connections/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await signFirebaseToken({ sub: "someoneElse" })}`,
      },
    });
    expect((await listConnections()).connections).toHaveLength(1);
  });

  it.each([
    ["no sign-in", undefined, 401],
    ["a sign-in that isn't the site's", "not-a-token", 401],
  ])("are refused with %s", async (_, token, status) => {
    for (const method of ["GET", "DELETE"]) {
      const response = await request(`${MCP}/connections`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      expect(response.status).toBe(status);
    }
  });

  it("answer the site's pages, and no other site's", async () => {
    const preflight = (origin: string) =>
      request(`${MCP}/connections`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "DELETE",
          "Access-Control-Request-Headers": "authorization",
        },
      });
    const site = await preflight(ORIGIN);
    expect(site.status).toBe(204);
    expect(site.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(site.headers.get("Access-Control-Allow-Methods")).toContain(
      "DELETE",
    );
    const other = await preflight("https://evil.example");
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("don't take anything but a connection's id", async () => {
    const response = await request(`${MCP}/connections/not%20an%20id`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await signFirebaseToken()}` },
    });
    expect(response.status).toBe(404);
  });
});
