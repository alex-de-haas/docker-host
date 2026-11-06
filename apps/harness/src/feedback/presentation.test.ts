import { expect, it } from "vitest";
import { feedbackPresentation, isFeedbackMessageReference } from "./presentation.js";
import type { FeedbackDispatch } from "@hosty-sdk/app/feedback";

const dispatch: Pick<FeedbackDispatch, "id" | "input" | "snapshot"> = {
  id: "e4c78168-cdfe-4a31-a376-d86f12556cbf",
  input: { requestId: "e4c78168-cdfe-4a31-a376-d86f12556cbf", sessionId: "chat", workspaceId: null,
    reports: [{ id: "report", revision: 3 }], instruction: "Keep the navigation" },
  snapshot: [{ id: "report", reporterId: "private-reporter", revision: 3, workspaceId: null, status: "unprocessed", currentAttemptId: null, disposition: null,
    comment: "Improve contrast", context: { appId: "vendor.notes", appName: "Notes", version: "2.3.4", installation: "private-installation",
      observedAt: "now", executionKind: "workspace", workspaceId: "private-workspace", sourceRevision: "private-head" },
    annotations: [{ id: "annotation", text: "This label is faint", route: "/notes", capturedAt: "now", mediaType: "image/png",
      target: { kind: "element", selector: "#private-selector" } },
      { id: "text-only", text: "Keep this layout", route: "/", capturedAt: "now", mediaType: null }] }],
};

it("projects ordered text, application attribution and image counts without evidence or private execution metadata", () => {
  expect(feedbackPresentation(dispatch)).toEqual({ version: 1, dispatchId: dispatch.id, instruction: "Keep the navigation", reports: [{
    id: "report", appId: "vendor.notes", appName: "Notes", version: "2.3.4", comment: "Improve contrast", annotations: [
      { id: "annotation", text: "This label is faint", route: "/notes", hasImage: true },
      { id: "text-only", text: "Keep this layout", route: "/", hasImage: false },
    ],
  }] });
});

it("does not rebuild a deleted or partly redacted batch", () => {
  expect(feedbackPresentation({ ...dispatch, snapshot: [] })).toBeNull();
  expect(feedbackPresentation({ ...dispatch, input: { ...dispatch.input, reports: [...dispatch.input.reports, { id: "removed", revision: 1 }] } })).toBeNull();
  expect(feedbackPresentation({ ...dispatch, input: { ...dispatch.input, reports: [{ id: "other", revision: 3 }] } })).toBeNull();
});

it("recognizes only the supported typed reference", () => {
  expect(isFeedbackMessageReference({ version: 1, dispatchId: dispatch.id })).toBe(true);
  for (const value of [null, {}, [], { version: 2, dispatchId: dispatch.id }, { version: 1, dispatchId: "arbitrary" }])
    expect(isFeedbackMessageReference(value)).toBe(false);
});
