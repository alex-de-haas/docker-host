// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceDetails } from "./workspace-details";
import { developmentRequest, type DevelopmentWorkspace, type Diff } from "@/lib/development-api";
import { prepareWorkspaceDiff } from "@/lib/workspace-diff";

vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("./workspace-diff-view", () => ({ default: ({ diff }: { diff: Diff }) => {
  const preview = prepareWorkspaceDiff(diff);
  return <pre data-testid="rendered-additions">{preview.kind === "diff" ? preview.file.additionLines.join("") : "fallback"}</pre>;
} }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const patch = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n";

it.each([
  ["??", "patch", "hello\n"],
  ["A ", "text", patch],
] as const)("uses response format when inventory still reports %s", async (status, contentKind, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const tree: DevelopmentWorkspace["worktrees"][number] = {
    id: "tree", workspaceId: "workspace", repository: "https://example.test/repo.git", branch: "work",
    state: "active", apps: [], leases: [], pullRequests: [],
    observation: { at: new Date().toISOString(), state: "ok", local: { files: [{ path: "new.txt", status }], truncated: false } },
    sessionChanges: [{ path: "new.txt", status }],
  };
  const w: DevelopmentWorkspace = { id: "workspace", state: "active", owner: { kind: "assistant", reference: "session", label: "Harness" }, worktrees: [tree], workflow: { state: "in-progress", revision: 0 } };
  vi.mocked(developmentRequest).mockImplementation(async (path = "") => {
    if (path.endsWith("/previews")) return { environments: [], instances: [], applications: {} } as never;
    if (path.includes("/diff?")) return { path: "new.txt", combined: patch, contentKind, binary: false, truncated: false } as never;
    return tree as never;
  });
  try {
    await act(async () => root.render(<WorkspaceDetails workspace={w} title="Race" refresh={() => {}} />));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Changes"))!.click());
    await act(async () => {
      const scope = document.querySelector<HTMLSelectElement>('[aria-label="Diff scope"]')!;
      scope.value = "local"; scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-testid="rendered-additions"]')?.textContent).toBe(expected);
    });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
