import { describe, expect, it } from "vitest";
import { composeAskDraft, MAX_DRAFT_CHARS } from "./ask-draft";

describe("composeAskDraft", () => {
  it("prefixes the source, so the operator sees where the text came from", () => {
    expect(composeAskDraft("", "disk is full", "hosty.telemetry")).toBe("From hosty.telemetry: disk is full");
  });

  it("appends rather than replacing what the operator was writing", () => {
    const draft = composeAskDraft("my own question", "disk is full", "hosty.telemetry");
    expect(draft.startsWith("my own question")).toBe(true);
    expect(draft).toContain("From hosty.telemetry: disk is full");
  });

  it("bounds the draft against a loop of accepted asks, keeping the newest", () => {
    // Each ask is capped by the embedder; a sequence of them is not. Without this an app that kept
    // asking would grow the draft until the tab suffered.
    let draft = "";
    for (let i = 0; i < 40; i += 1) {
      draft = composeAskDraft(draft, "x".repeat(1000), "hosty.telemetry");
    }
    expect(draft.length).toBe(MAX_DRAFT_CHARS);
    expect(draft.endsWith("x".repeat(100))).toBe(true);
  });

  it("returns a draft and nothing else — the operator sends", () => {
    // Structural, and the point of keeping this pure: there is no path from an app's text to a sent
    // message, rather than a rule someone has to remember not to break.
    expect(typeof composeAskDraft("", "anything", "any.app")).toBe("string");
  });
});
