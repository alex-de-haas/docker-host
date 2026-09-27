import { describe, expect, it } from "vitest";
import { isWaiting, orderSessions, waitingCount } from "./attention.js";

const session = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });

describe("attention", () => {
  it("counts only what needs a person", () => {
    expect(isWaiting("awaiting_approval")).toBe(true);
    expect(isWaiting("awaiting_question")).toBe(true);
    expect(isWaiting("running")).toBe(false);
  });

  it("puts blocked sessions first, then the newest", () => {
    // "Running in the background" means "waiting for you" as often as "working". A chronological list
    // makes the operator scroll looking for the one row that needs them.
    const ordered = orderSessions([
      session("new-running", "running", "2026-08-20T10:00:00Z"),
      session("old-blocked", "awaiting_approval", "2026-08-19T10:00:00Z"),
      session("old-running", "running", "2026-08-18T10:00:00Z"),
      session("new-blocked", "awaiting_question", "2026-08-20T11:00:00Z"),
    ]);

    expect(ordered.map((record) => record.id)).toEqual([
      "new-blocked",
      "old-blocked",
      "new-running",
      "old-running",
    ]);
  });

  it("does not mutate what it was given", () => {
    // The list is React state; sorting it in place would mutate a rendered array.
    const input = [session("a", "running", "2026-08-18T10:00:00Z"), session("b", "awaiting_question", "2026-08-19T10:00:00Z")];
    orderSessions(input);
    expect(input.map((record) => record.id)).toEqual(["a", "b"]);
  });

  it("counts the blocked ones", () => {
    expect(waitingCount([session("a", "running", "x"), session("b", "awaiting_approval", "x")])).toBe(1);
    expect(waitingCount([])).toBe(0);
  });
});
