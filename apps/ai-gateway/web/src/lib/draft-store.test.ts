import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, pruneDrafts, readDraft, writeDraft } from "./draft-store.js";

/** Enough of the Storage surface for these paths, including the throwing case. */
function installStorage(throws = false): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (throws ? raise() : map.get(key) ?? null),
    setItem: (key: string, value: string) => (throws ? raise() : void map.set(key, value)),
    removeItem: (key: string) => (throws ? raise() : void map.delete(key)),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  return map;
}

function raise(): never {
  throw new DOMException("denied");
}

describe("draft store", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a draft per session, not one for the panel", () => {
    // Switching sessions and finding someone else's half-written sentence in the box would be its own
    // kind of loss — the one this feature exists to prevent, wearing a different shape.
    installStorage();
    writeDraft("a", "about the disk error");
    writeDraft("b", "about something else");

    expect(readDraft("a")).toBe("about the disk error");
    expect(readDraft("b")).toBe("about something else");
  });

  it("treats an emptied box as a decision", () => {
    // Leaving the old text behind would resurrect something the operator deliberately cleared.
    installStorage();
    writeDraft("a", "typed");
    writeDraft("a", "   ");

    expect(readDraft("a")).toBe("");
  });

  it("forgets a draft once its text was sent", () => {
    installStorage();
    writeDraft("a", "sent");
    clearDraft("a");

    expect(readDraft("a")).toBe("");
  });

  it("drops drafts of sessions the gateway no longer has", () => {
    // Otherwise the store grows for the life of the browser profile, with keys the operator cannot see.
    const map = installStorage();
    writeDraft("live", "keep");
    writeDraft("gone", "discard");

    pruneDrafts(["live"]);

    expect(readDraft("live")).toBe("keep");
    expect(readDraft("gone")).toBe("");
    expect(map.size).toBe(1);
  });

  it("survives storage that refuses everything", () => {
    // Private modes and quota limits throw. Losing a draft is the cost this feature reduces; failing
    // to open the assistant because one could not be stored would be a far worse trade.
    installStorage(true);

    expect(() => writeDraft("a", "text")).not.toThrow();
    expect(() => clearDraft("a")).not.toThrow();
    expect(() => pruneDrafts(["a"])).not.toThrow();
    expect(readDraft("a")).toBe("");
  });
});
