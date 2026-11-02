import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HostyAppFrameProps } from "@hosty-sdk/app/ui/react";
import { AppContent } from "../src/components/app-content";
vi.mock("@hosty-sdk/app/ui/react", () => ({ HostyAppFrame: ({ src, surface }: HostyAppFrameProps) => <iframe src={src} data-endpoint={surface?.endpoint} /> }));
it("restores destination readiness and endpoint from reordered manifest pages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<AppContent app={{ id: "reviewer", installationId: "i1", displayName: "Reviews", runtimeState: "running",
      navigation: [{ label: "Unavailable", path: "/old", endpoint: "old", service: "old", embeddedUrl: "https://old.test/old" },
        { label: "Reviews", path: "/reviews", endpoint: "reviews", service: "reviews", embeddedUrl: "https://reviews.test/reviews" }],
      health: { services: [{ service: "old", status: "stopped" }, { service: "reviews", status: "running" }] } }}
      windowId="window" destination={{ endpoint: "reviews", route: "/reviews?pr=42" }} installationId="i1" pageIndex={0}
      theme="light" preference="light" admin={false} onPage={() => {}} onStart={() => {}} onRetry={() => {}} />));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("https://reviews.test/reviews?pr=42");
    expect(container.querySelector("iframe")?.dataset.endpoint).toBe("reviews");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Reviews");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
