import { describe, expect, it, vi } from "vitest";

import { listTools, openSession } from "./upstream.js";

// The budget guard, asserted at the primitive rather than through a ten-second walk.
//
// The facade spends one budget across a whole source — handshake and every page together — which
// only bites if an exhausted budget stops a call from being made at all. Without this, each page
// got a fresh timeout and one slow app could hold the catalog's fan-out for twenty times as long as
// intended, timing out the client that was waiting on it.
describe("upstream budget", () => {
  it("makes no request once the budget is spent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await openSession("http://app.test/api/mcp", "token", "test", 0)).toBeNull();
    expect(await listTools("http://app.test/api/mcp", "token", { id: null }, undefined, -1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
