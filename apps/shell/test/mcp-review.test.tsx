import { expect, it } from "vitest";
import { mcpReviewRequest } from "../src/app/shell/embedding/mcp-review";
it("binds review to the sending frame and ignores forged assistant IDs and URLs", () => {
  const frame = {} as Window;
  const event = { source: frame, origin: "https://harness.test", data: {
    type: "hosty:request-mcp-review", targetAppId: "hosty:core", appId: "another.assistant", url: "https://evil.test",
  } } as unknown as MessageEvent;
  expect(mcpReviewRequest(event, frame, "https://harness.test/settings", "hosty.harness"))
    .toEqual({ appId: "hosty.harness", targetAppId: "hosty:core" });
  expect(mcpReviewRequest(event, {} as Window, "https://harness.test/settings", "hosty.harness")).toBeNull();
  expect(mcpReviewRequest({ ...event, origin: "https://evil.test" } as MessageEvent, frame, "https://harness.test", "hosty.harness")).toBeNull();
  expect(mcpReviewRequest({ ...event, data: { ...event.data, targetAppId: "../../evil" } } as MessageEvent, frame, "https://harness.test", "hosty.harness")).toBeNull();
});
