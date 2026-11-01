import { expect, it, vi } from "vitest";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentObservations } from "./observations.js";
import { SessionStore } from "../sessions/store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
    if (process.platform === "win32" && (await fs.stat(args[0]).catch(() => null))?.isDirectory())
      throw Object.assign(new Error("Windows cannot open a directory for fsync"), { code: "EPERM" });
    return fs.open(...args);
  }) };
});

it("persists observations on Windows without opening a directory for fsync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hosty-windows-observations-"));
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  const observations = new AgentObservations(new SessionStore(root));
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await observations.change(state => { state.cancellations.push({ key: "request", fingerprint: "input", runId: "run", state: "pending" }); });
    expect(JSON.parse(await readFile(path.join(root, "agent-observations.json"), "utf8")).cancellations).toHaveLength(1);
    expect(vi.mocked(open).mock.calls.every(call => call[1] === "wx")).toBe(true);
  } finally { Object.defineProperty(process, "platform", original); observations.close(); await rm(root, { recursive: true, force: true }); }
});
