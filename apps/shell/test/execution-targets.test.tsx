import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useExecutionTargets } from "../src/app/shell/execution-targets";
import type { CoreApp } from "../src/app/shell/types";
const fixture = vi.hoisted(() => ({ read: vi.fn(), sync: null as null | (() => Promise<void>), dispose: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: { appChanged: "app.changed", appRemoved: "app.removed", workspaceChanged: "workspace.changed" },
  subscribeToCoreEvents: (_origin: string, options: { onSync: () => Promise<void>; topic?: string }) => { if (!options.topic) { fixture.sync = options.onSync; void options.onSync(); } return fixture.dispose; } }));
let root: Root, container: HTMLDivElement;
const app = { id: "a", selectedRuntime: "dev", sourceLivePath: "/tree" } as CoreApp;
const response = (name: string) => Response.json({ apps: [{ appId: "a", current: { kind: "workspace", workspaceId: "w", worktreeId: "t", name }, choices: [], packageRuntime: "docker" }] });
function Probe({ apps }: { apps: CoreApp[] }) { const targets = useExecutionTargets("https://core.test", apps, true); return <>{targets[0]?.current.name}</>; }
beforeEach(() => { fixture.read.mockReset(); fixture.dispose.mockReset(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("updates names on workspace metadata events without changing the running source", async () => {
  fixture.read.mockResolvedValue(response("Small layout fix"));
  await act(async () => root.render(<Probe apps={[app]} />));
  expect(container.textContent).toBe("Small layout fix");
  fixture.read.mockResolvedValue(response("Simplify runtime selection"));
  await act(async () => fixture.sync!());
  expect(container.textContent).toBe("Simplify runtime selection");
  await act(async () => root.render(<Probe apps={[{ ...app, runtimeState: "running" }]} />));
  expect(fixture.read).toHaveBeenCalledTimes(2);
});
it("does not apply an old inventory after source selection changes", async () => {
  let resolve!: (response: Response) => void;
  fixture.read.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  await act(async () => root.render(<Probe apps={[app]} />));
  const signal = fixture.read.mock.calls[0][1].signal;
  fixture.read.mockResolvedValue(response("New source"));
  await act(async () => root.render(<Probe apps={[{ ...app, sourceLivePath: "/new" }]} />));
  await act(async () => resolve(response("Old source")));
  expect(signal.aborted).toBe(true); expect(container.textContent).toBe("New source");
});
