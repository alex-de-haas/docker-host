import { expect, it } from "vitest";
import { feedbackWorkspace, type FeedbackWorkspaceSession } from "./workspace.js";

it.each<[string, FeedbackWorkspaceSession, string | null]>([
  ["an independent chat", {}, null],
  ["a native source-prepared chat", { developmentWorkspaces: [{ state: "active", workspaceId: "source" }] }, "source"],
  ["several repositories in one workspace", { developmentWorkspaces: [
    { state: "active", workspaceId: "shared" }, { state: "active", workspaceId: "shared" },
  ] }, "shared"],
  ["released source history", { developmentWorkspaces: [{ state: "released", workspaceId: "old" }] }, null],
  ["active source and released history", { developmentWorkspaces: [
    { state: "released", workspaceId: "old" }, { state: "active", workspaceId: "current" },
  ] }, "current"],
  ["ambiguous active source", { developmentWorkspaces: [
    { state: "active", workspaceId: "first" }, { state: "active", workspaceId: "second" },
  ] }, null],
  ["source without aggregate workspace identity", { developmentWorkspaces: [
    { state: "active" }, { state: "active", workspaceId: null }, { state: "active", workspaceId: "" },
  ] }, null],
  ["an explicit association", { workspaceAssociation: { id: "selected" }, developmentWorkspaces: [
    { state: "active", workspaceId: "first" }, { state: "active", workspaceId: "second" },
  ] }, "selected"],
  ["a detached chat", { workspaceAssociation: null, developmentWorkspaces: [] }, null],
  ["source prepared after a previous detach", { workspaceAssociation: null,
    developmentWorkspaces: [{ state: "active", workspaceId: "new" }] }, "new"],
])("resolves %s consistently for review and admission", (_name, session, workspace) => {
  expect(feedbackWorkspace(session)).toBe(workspace);
});
