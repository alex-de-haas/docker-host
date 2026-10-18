import { describe, expect, it } from "vitest";
import { isWaiting, orderSessions, waitingCount } from "./attention.js";

const session = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });

describe("attention", () => {
  it("counts only what needs a person", () => {
    expect(isWaiting("awaiting_approval")).toBe(true);
    expect(isWaiting("awaiting_question")).toBe(true);
    expect(isWaiting("running")).toBe(false);
  });

  it("orders by last change, without pinning older waiting sessions", () => {
    const ordered = orderSessions([
      session("new-running", "running", "2026-08-20T10:00:00Z"),
      session("old-blocked", "awaiting_approval", "2026-08-19T10:00:00Z"),
      session("old-running", "running", "2026-08-18T10:00:00Z"),
      session("new-blocked", "awaiting_question", "2026-08-20T11:00:00Z"),
    ]);

    expect(ordered.map((record) => record.id)).toEqual([
      "new-blocked",
      "new-running",
      "old-blocked",
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

it("uses saved activity over creation time with safe legacy and invalid-date fallbacks", () => {
  const records = [
    { ...session("active-old-chat", "idle", "2026-01-01"), updatedAt: "2026-10-18" },
    session("new-chat", "idle", "2026-10-17"),
    { ...session("invalid-update", "idle", "2026-10-16"), updatedAt: "bad" },
    session("z-unknown", "awaiting_approval", "bad"), session("a-unknown", "idle", "bad"),
  ];
  expect(orderSessions(records.reverse()).map(s => s.id)).toEqual(["active-old-chat", "new-chat", "invalid-update", "a-unknown", "z-unknown"]);
});
