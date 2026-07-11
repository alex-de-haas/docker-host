import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmbeddingOrigin, rememberParentOrigin, resolveEmbeddingOrigin } from "@/lib/embedding-origin";

function stubFrame(referrer: string, store: Map<string, string> = new Map()): Map<string, string> {
  vi.stubGlobal("document", { referrer });
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
  return store;
}

describe("resolveEmbeddingOrigin", () => {
  it("returns only an HTTP(S) referrer origin", () => {
    expect(resolveEmbeddingOrigin("https://hosty.example/shell/apps/marketplace?theme=dark")).toBe("https://hosty.example");
    expect(resolveEmbeddingOrigin("http://127.0.0.1:7171/")).toBe("http://127.0.0.1:7171");
    expect(resolveEmbeddingOrigin("file:///tmp/index.html")).toBeNull();
    expect(resolveEmbeddingOrigin("")).toBeNull();
  });
});

describe("getEmbeddingOrigin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the referrer before any parent message is seen", () => {
    stubFrame("http://127.0.0.1:7171/shell/apps/marketplace");
    expect(getEmbeddingOrigin()).toBe("http://127.0.0.1:7171");
  });

  it("prefers a remembered parent origin over the referrer", () => {
    stubFrame("http://127.0.0.1:7171/shell/apps/marketplace");
    rememberParentOrigin("http://127.0.0.1:7171");
    expect(getEmbeddingOrigin()).toBe("http://127.0.0.1:7171");
  });

  it("keeps the remembered Shell origin after a self-reload rewrites the referrer to our own", () => {
    // First load: the Shell's theme message teaches us its origin, which we persist.
    const store = stubFrame("http://127.0.0.1:7171/shell/apps/marketplace");
    rememberParentOrigin("http://127.0.0.1:7171");

    // After AppIdentityBridge reloads, document.referrer becomes our own origin — the stored Shell
    // origin must still win so postMessage keeps targeting the real parent.
    stubFrame("http://127.0.0.1:51405/", store);
    expect(getEmbeddingOrigin()).toBe("http://127.0.0.1:7171");
  });

  it("ignores non-HTTP origins and returns null when nothing is known", () => {
    stubFrame("");
    rememberParentOrigin("null");
    expect(getEmbeddingOrigin()).toBeNull();
  });
});
