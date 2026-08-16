import { afterEach, describe, expect, it, vi } from "vitest";
import { readOnlyToolNames } from "./readonly.js";

// Which tools an app declares read-only, and — more importantly — when the answer is "we do not
// know". Null and an empty set must never be confused: only one of them may lead to skipping an
// approval card.

const URL = "http://notes/api/mcp";

function stub(handler: (method: string, request: Request) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
    return handler(body.method, new Request(String(input), init as RequestInit));
  });
}

function json(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const TOOLS = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      { name: "list_people", annotations: { readOnlyHint: true } },
      { name: "delete_person", annotations: { readOnlyHint: false } },
      { name: "rename_person" },
      { name: "odd", annotations: { readOnlyHint: "true" } },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

describe("read-only discovery", () => {
  it("takes only an explicit readOnlyHint: true", async () => {
    // Fail-closed per tool: false, absent, and a string all mean "we do not know what this does".
    stub(() => json(TOOLS));

    expect([...(await readOnlyToolNames(URL, "t"))!]).toEqual(["list_people"]);
  });

  it("runs the lifecycle before listing, and carries the session id", async () => {
    // An app on a standard MCP SDK rejects a bare tools/list, so skipping this would have quietly
    // yielded nothing for exactly the apps most likely to be built properly.
    const methods: string[] = [];
    const sessionHeaders: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      methods.push(body.method);
      sessionHeaders.push(headers.get("mcp-session-id"));
      return json(TOOLS, { "mcp-session-id": "sess-1" });
    });

    await readOnlyToolNames(URL, "t");

    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(sessionHeaders).toEqual([null, "sess-1", "sess-1"]);
  });

  it("understands an SSE-framed answer", async () => {
    stub((method) =>
      method === "tools/list"
        ? new Response(`event: message\ndata: ${JSON.stringify(TOOLS)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        : json({ jsonrpc: "2.0", id: 1, result: {} }),
    );

    expect([...(await readOnlyToolNames(URL, "t"))!]).toEqual(["list_people"]);
  });

  it("says 'do not know' rather than 'nothing' when it cannot read the list", async () => {
    // The distinction the caller depends on. An app that is stopped, refuses, or answers with the
    // wrong shape must not look like an app with no read-only tools — the first has to keep asking.
    stub(() => new Response("no", { status: 503 }));
    expect(await readOnlyToolNames(URL, "t")).toBeNull();

    stub((method) =>
      method === "tools/list" ? json({ jsonrpc: "2.0", id: 1, result: null }) : json({ result: {} }),
    );
    expect(await readOnlyToolNames(URL, "t")).toBeNull();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    expect(await readOnlyToolNames(URL, "t")).toBeNull();

    // Beside the case that must still work, so "returns null always" cannot pass for correct.
    stub(() => json(TOOLS));
    expect(await readOnlyToolNames(URL, "t")).not.toBeNull();
  });

  it("follows pagination, so a later page is not silently left asking", async () => {
    // The failure is conservative — those tools keep raising cards — but it is still the operator's
    // setting not doing what it says on an app they explicitly vouched for.
    const cursors: (string | undefined)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params?: { cursor?: string };
      };
      if (body.method !== "tools/list") {
        return json({ jsonrpc: "2.0", id: 1, result: {} });
      }
      cursors.push(body.params?.cursor);
      return cursors.length === 1
        ? json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [{ name: "page_one", annotations: { readOnlyHint: true } }],
              nextCursor: "c2",
            },
          })
        : json({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "page_two", annotations: { readOnlyHint: true } }] },
          });
    });

    expect([...(await readOnlyToolNames(URL, "t"))!]).toEqual(["page_one", "page_two"]);
    expect(cursors).toEqual([undefined, "c2"]);
  });

  it("refuses rather than truncating when a later page cannot be read", async () => {
    // A partial grant is indistinguishable from a complete one where it is consulted, so half an
    // answer is worse than none.
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method !== "tools/list") {
        return json({ jsonrpc: "2.0", id: 1, result: {} });
      }
      call++;
      return call === 1
        ? json({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "a", annotations: { readOnlyHint: true } }], nextCursor: "c2" },
          })
        : new Response("gone", { status: 503 });
    });

    expect(await readOnlyToolNames(URL, "t")).toBeNull();
  });

  it("stops rather than spinning on an app that always returns a cursor", async () => {
    // The cursor comes from the app, so it is not trustworthy input.
    stub((method) =>
      method === "tools/list"
        ? json({ jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "always" } })
        : json({ jsonrpc: "2.0", id: 1, result: {} }),
    );

    expect(await readOnlyToolNames(URL, "t")).toBeNull();
  });

  it("an app with nothing read-only is an empty set, not null", async () => {
    stub((method) =>
      method === "tools/list"
        ? json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "delete_all" }] } })
        : json({ result: {} }),
    );

    const names = await readOnlyToolNames(URL, "t");
    expect(names).not.toBeNull();
    expect(names!.size).toBe(0);
  });
});
