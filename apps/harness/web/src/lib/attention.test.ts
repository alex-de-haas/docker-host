import { describe, expect, it } from "vitest";
import { isWaiting, orderSessions, waitingCount } from "./attention.js";

const session = (id: string, status: string, lastUserPromptAt?: string | null) => ({ id, status, lastUserPromptAt });

describe("attention", () => {
  it("counts only what needs a person", () => {
    expect(isWaiting("awaiting_approval")).toBe(true);
    expect(isWaiting("awaiting_question")).toBe(true);
    expect(isWaiting("running")).toBe(false);
  });

  it("orders by last user prompt regardless of status or activity", () => {
    const ordered = orderSessions([
      session("new-running", "running", "2026-08-20T10:00:00Z"),
      { ...session("old-blocked", "awaiting_approval", "2026-08-19T10:00:00Z"), updatedAt: "2026-08-21T10:00:00Z" },
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
    expect(waitingCount([{ ...session("a", "awaiting_question", "x"), providerStatusContact: { runId: "run", observedAt: "2026-11-19T10:00:00Z", reason: "unavailable" } }])).toBe(0);
    const archiveOffline = { ...session("a", "awaiting_question", "x"), providerHistoryContact: { runId: "run", observedAt: "2026-11-19T10:00:00Z", reason: "unavailable" } };
    expect(waitingCount([archiveOffline])).toBe(1);
    expect(waitingCount([])).toBe(0);
  });
});

it("keeps chats without a valid prompt date at the end in stable ID order", () => {
  const records = [
    { ...session("dated", "idle", "2026-01-01"), createdAt: "2026-01-01" },
    { ...session("new-chat", "idle", null), createdAt: "2026-10-17" },
    { ...session("invalid-prompt", "idle", "bad"), updatedAt: "2026-10-18" },
    session("z-unknown", "awaiting_approval"), session("a-unknown", "idle"),
  ];
  expect(orderSessions(records.reverse()).map(s => s.id)).toEqual(["dated", "a-unknown", "invalid-prompt", "new-chat", "z-unknown"]);
});
