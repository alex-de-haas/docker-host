import { describe, expect, it } from "vitest";
import { deriveTitleFromMessage, MAX_TITLE_CHARS, normalizeTitle } from "./title.js";

describe("session titles from a message", () => {
  it("names a session after the ask, not the log pasted under it", () => {
    // The shape operators actually send: the question on line one, evidence below. A first-sentence
    // rule would name this session after a stack trace.
    const title = deriveTitleFromMessage("Why did telemetry stop?\n\nfatal: bind EADDRINUSE 4318\n  at Server...");
    expect(title).toBe("Why did telemetry stop?");
  });

  it("skips leading blank and punctuation-only lines", () => {
    expect(deriveTitleFromMessage("\n\n---\nDisk pressure on the host")).toBe("Disk pressure on the host");
  });

  it("collapses the whitespace a paste brings with it", () => {
    expect(deriveTitleFromMessage("  restart   the    collector  ")).toBe("restart the collector");
  });

  it("cuts a long opening line at a word boundary", () => {
    const title = deriveTitleFromMessage("word ".repeat(40))!;
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("wor…");
  });

  it("cuts mid-token when there is no word boundary to cut at", () => {
    // A single pasted identifier or URL has no space to break on; it is still bounded.
    const title = deriveTitleFromMessage("x".repeat(200))!;
    expect(title.length).toBe(MAX_TITLE_CHARS + 1);
  });

  it("leaves a session unnamed rather than naming it after punctuation", () => {
    expect(deriveTitleFromMessage("   ")).toBeNull();
    expect(deriveTitleFromMessage("...\n---")).toBeNull();
  });
});

describe("an operator's own title", () => {
  it("normalizes what was typed", () => {
    expect(normalizeTitle("  disk   pressure ")).toBe("disk pressure");
  });

  it("treats an emptied box as clearing the name", () => {
    // Not the empty string: a cleared title returns the session to `auto`, and the next message
    // derives one again.
    expect(normalizeTitle("   ")).toBeNull();
    expect(normalizeTitle(undefined)).toBeNull();
    expect(normalizeTitle(42)).toBeNull();
  });

  it("bounds a title pasted rather than typed", () => {
    expect(normalizeTitle("y".repeat(500))!.length).toBe(MAX_TITLE_CHARS + 1);
  });
});
