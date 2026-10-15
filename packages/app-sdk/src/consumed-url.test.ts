// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceConsumedUrl } from "./consumed-url";

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
const flushEffects = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("consumed callback URL synchronization", () => {
  it("updates a router installed after the child effect before a later HMR render", async () => {
    window.history.replaceState(null, "", "/draft?code=consumed&state=attempt&filter=open#item");
    let canonical = window.location.href;
    const clean = new URL(canonical); clean.searchParams.delete("code"); clean.searchParams.delete("state");
    replaceConsumedUrl(clean);
    expect(window.location.href).toBe(clean.href);
    // The parent framework effect is deliberately later than callback consumption.
    const nativeReplace = window.history.replaceState.bind(window.history);
    vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
      canonical = new URL(String(url), window.location.href).href;
      nativeReplace(data, unused, url);
    });
    await flushEffects();
    nativeReplace(null, "", canonical); // A subsequent framework render restores its canonical URL.
    expect(window.location.search).toBe("?filter=open");
    expect(window.location.hash).toBe("#item");
  });

  it("preserves state installed for the cleaned URL before deferred synchronization", async () => {
    window.history.replaceState(null, "", "/draft?code=consumed&filter=open");
    const clean = new URL(window.location.href); clean.searchParams.delete("code");
    replaceConsumedUrl(clean);
    const routerState = { navigationKey: "keep", scroll: { x: 0, y: 140 }, draft: "unsaved" };
    window.history.replaceState(routerState, "", clean.href);
    const replace = vi.spyOn(window.history, "replaceState");
    await flushEffects();
    expect(replace).toHaveBeenCalledExactlyOnceWith(routerState, "", "/draft?filter=open");
    expect(window.history.state).toEqual(routerState);
    expect(window.location.href).toBe(clean.href);
  });

  it("does not overwrite navigation before the deferred synchronization", async () => {
    window.history.replaceState(null, "", "/?code=consumed");
    replaceConsumedUrl(new URL("/", window.location.href));
    window.history.pushState({ draft: "keep" }, "", "/people?sort=name#selected");
    await flushEffects();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/people?sort=name#selected");
    expect(window.history.state).toEqual({ draft: "keep" });
  });

  it("synchronizes only the latest of several launch parameter cleanups", async () => {
    window.history.replaceState(null, "", "/?code=consumed&hosty_launch=embedded&filter=open");
    const auth = new URL(window.location.href); auth.searchParams.delete("code"); replaceConsumedUrl(auth);
    const launch = new URL(window.location.href); launch.searchParams.delete("hosty_launch"); replaceConsumedUrl(launch);
    const replace = vi.spyOn(window.history, "replaceState");
    await flushEffects();
    expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/?filter=open");
    expect(window.location.search).toBe("?filter=open");
  });
});
