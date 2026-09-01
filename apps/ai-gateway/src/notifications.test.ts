import { afterEach, describe, expect, it, vi } from "vitest";
import { dedupeKeyFor, isWaitingStatus, WaitingNotifier } from "./notifications.js";

describe("waiting notifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("counts only the statuses that need a person", () => {
    // "Running" is the agent working and needs nobody; announcing it would train the operator to
    // ignore the inbox, which costs the announcements that do matter.
    expect(isWaitingStatus("awaiting_approval")).toBe(true);
    expect(isWaitingStatus("awaiting_question")).toBe(true);
    for (const status of ["running", "idle", "failed", "cancelled"]) {
      expect(isWaitingStatus(status)).toBe(false);
    }
  });

  it("keys dedupe by session, so a long run does not fill the inbox", () => {
    // Every approval in one run is another wait. One row per approval is an inbox nobody reads.
    expect(dedupeKeyFor("s1")).toBe(dedupeKeyFor("s1"));
    expect(dedupeKeyFor("s1")).not.toBe(dedupeKeyFor("s2"));
  });

  it("targets the operator who started the session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    new WaitingNotifier("http://core.test", "service-token", "hosty.ai-gateway")
      .waiting("s1", "awaiting_approval", "user_admin");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    // Not broadcast: another administrator being told that someone else's agent is waiting is noise
    // they cannot act on.
    expect(body.target).toBe("user_admin");
    expect(body.dedupeKey).toBe(dedupeKeyFor("s1"));
    // No transcript content — what was proposed lives in the session, and an inbox row is not the
    // place to repeat text nobody has approved.
    expect(JSON.stringify(body)).not.toContain("transcript");
  });

  it("says nothing when it has no operator to tell", async () => {
    // A session with no recorded owner has nobody to notify, and guessing would mean telling the
    // wrong person.
    const fetchMock = vi.spyOn(globalThis, "fetch");
    new WaitingNotifier("http://core.test", "service-token", "hosty.ai-gateway")
      .waiting("s1", "awaiting_approval", null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when Core is unreachable, and says so exactly once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    // Captured rather than left to escape. `waiting` is fire-and-forget, so the swallowed rejection
    // warns on a later microtask — after this test returns. An unwatched warning then lands at an
    // unpredictable moment, sometimes while the vitest worker is already closing its RPC, which
    // fails an otherwise green run as an EnvironmentTeardownError. This suite has had that failure
    // on CI. Waiting for the warning is what the test above already does for the fetch itself.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifier = new WaitingNotifier("http://core.test", "service-token", "hosty.ai-gateway");
    // A missed notification costs a slower reply; a session that failed because one could not be
    // delivered would be a far worse trade.
    expect(() => notifier.waiting("s1", "awaiting_question", "user_admin")).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("Core unreachable");

    // The muting was the untested half: a gateway that cannot reach Core keeps trying on every
    // wait, and a warning per attempt would bury the log it is meant to explain.
    notifier.waiting("s2", "awaiting_question", "user_admin");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // A macrotask, so every microtask the second rejection settles on has already run. Without this
    // the check passed with the muting deleted — it was outrunning the warning, not observing its
    // absence, which is the same race this test exists to remove.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
