// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { readWorkSelection, rememberWorkSelection, WORK_SELECTION_STORAGE_KEY } from "./work-selection";

beforeEach(() => localStorage.clear());

it.each(["/chats", "/chats/"])("imports only the matching historical selection at %s", path => {
  localStorage.setItem("hosty.harness.chats.session", "chat");
  localStorage.setItem("hosty.harness.workspaces.session", "workspace-chat");
  expect(readWorkSelection(path)).toEqual({ sessionId: "chat" });
  expect(readWorkSelection("/development/")).toEqual({ sessionId: "chat" });
});

it("imports the workspace page selection when it is the first unified entry", () => {
  localStorage.setItem("hosty.harness.chats.session", "chat");
  localStorage.setItem("hosty.harness.workspaces.session", "workspace-chat");
  expect(readWorkSelection("/development/")).toEqual({ sessionId: "workspace-chat" });
  expect(readWorkSelection("/chats")).toEqual({ sessionId: "workspace-chat" });
});

it("remembers workspace-only and explicit empty selections across either entry", () => {
  localStorage.setItem("hosty.harness.chats.session", "deleted-chat");
  rememberWorkSelection({ workspaceId: "empty-workspace" });
  expect(readWorkSelection("/chats/")).toEqual({ workspaceId: "empty-workspace" });
  rememberWorkSelection({}); expect(readWorkSelection("/chats/")).toEqual({});
});

it.each(["broken JSON", "null", "[]", '{"sessionId":42}'])("recovers malformed saved selection %s using the matching path", stored => {
  localStorage.setItem(WORK_SELECTION_STORAGE_KEY, stored);
  localStorage.setItem("hosty.harness.chats.session", "legacy-chat");
  expect(readWorkSelection("/chats/")).toEqual({ sessionId: "legacy-chat" });
});
