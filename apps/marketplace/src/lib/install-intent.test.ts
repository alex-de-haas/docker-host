import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstallFeedIntent,
  INSTALL_FEED_INTENT_TYPE,
  INSTALL_FEED_INTENT_VERSION,
  postInstallFeedIntent,
  resolveEmbeddingOrigin,
} from "@/lib/install-intent";

describe("createInstallFeedIntent", () => {
  it("creates the exact versioned message with a selected feed", () => {
    expect(createInstallFeedIntent(" https://apps.example/feeds.json ", " stable ")).toEqual({
      type: INSTALL_FEED_INTENT_TYPE,
      version: INSTALL_FEED_INTENT_VERSION,
      feedsUrl: "https://apps.example/feeds.json",
      feedId: "stable",
    });
  });

  it("omits the optional feedId instead of sending null", () => {
    const intent = createInstallFeedIntent("http://localhost:8080/feeds.json");

    expect(intent).toEqual({
      type: "hosty:install-feed",
      version: 1,
      feedsUrl: "http://localhost:8080/feeds.json",
    });
    expect(intent).not.toHaveProperty("feedId");
  });

  it.each([
    "file:///tmp/feeds.json",
    "relative/feeds.json",
    "https://user:secret@apps.example/feeds.json",
  ])("rejects unsafe feed URL %s", value => {
    expect(() => createInstallFeedIntent(value)).toThrow("HTTP(S)");
  });

  it("rejects blank or oversized feed ids", () => {
    expect(() => createInstallFeedIntent("https://apps.example/feeds.json", " ")).toThrow("1 to 128");
    expect(() => createInstallFeedIntent("https://apps.example/feeds.json", "x".repeat(129))).toThrow("1 to 128");
  });
});

describe("postInstallFeedIntent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubEmbedding(referrer: string): { postMessage: ReturnType<typeof vi.fn> } {
    const parent = { postMessage: vi.fn() };
    vi.stubGlobal("window", { parent, postMessage: parent.postMessage });
    vi.stubGlobal("document", { referrer });
    return parent;
  }

  it("posts to the exact referrer origin, never a wildcard", () => {
    const parent = stubEmbedding("https://hosty.example/shell/apps/marketplace");

    const result = postInstallFeedIntent("https://apps.example/feeds.json", "stable");

    expect(result).toEqual({ ok: true });
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: INSTALL_FEED_INTENT_TYPE, version: INSTALL_FEED_INTENT_VERSION, feedsUrl: "https://apps.example/feeds.json", feedId: "stable" },
      "https://hosty.example",
    );
    expect(parent.postMessage.mock.calls[0][1]).not.toBe("*");
  });

  it("refuses to send when not embedded in a parent frame", () => {
    const parent = { postMessage: vi.fn() };
    const self = { parent: undefined as unknown, postMessage: parent.postMessage };
    self.parent = self; // window.parent === window when top-level
    vi.stubGlobal("window", self);
    vi.stubGlobal("document", { referrer: "https://hosty.example/shell" });

    expect(postInstallFeedIntent("https://apps.example/feeds.json").ok).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("refuses when the embedding origin cannot be resolved from the referrer", () => {
    const parent = stubEmbedding("");

    expect(postInstallFeedIntent("https://apps.example/feeds.json").ok).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});

describe("resolveEmbeddingOrigin", () => {
  it("returns only an HTTP(S) referrer origin", () => {
    expect(resolveEmbeddingOrigin("https://hosty.example/shell/apps/marketplace?theme=dark")).toBe("https://hosty.example");
    expect(resolveEmbeddingOrigin("http://localhost:3000/shell")).toBe("http://localhost:3000");
    expect(resolveEmbeddingOrigin("file:///tmp/index.html")).toBeNull();
    expect(resolveEmbeddingOrigin("")).toBeNull();
  });
});
