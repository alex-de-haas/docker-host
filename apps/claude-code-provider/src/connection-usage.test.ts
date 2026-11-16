import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeConnections as AgentConnections } from "./connections.js";
import { ClaudeHarnessAdapter } from "./adapter/claude.js";
import { absentUsage, type ProviderUsage } from "@hosty/agent-provider-runtime/harness/provider-usage";
const sampleUsage = (): ProviderUsage => ({ state: "available", observedAt: new Date().toISOString(), rows: [{id:"account",group:"account",label:"Account",kind:"quota",unit:"percent",used:7,observedAt:new Date().toISOString()}] });
const resources: { root: string; connections: AgentConnections }[] = [];
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.connections.shutdown(); await rm(resource.root, { recursive: true, force: true }); } vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-usage-")), secrets = new Map<string, string>();
  const connections = new AgentConnections(root, root, { get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } });
  resources.push({ root, connections });
  const connection = await connections.update({ name: "fixture", kind: "claude", auth: "claude-token", secret: "synthetic" });
  return { connections, connection, secrets };
}
it("renames preserve observations; credential changes and revocation invalidate them", async () => {
  const { connections, connection, secrets } = await fixture();
  const read = vi.spyOn(ClaudeHarnessAdapter.prototype, "readUsage").mockResolvedValue(sampleUsage());
  expect((await connections.usage(connection.id, true)).rows[0]?.used).toBe(7);
  await connections.update({ name: "renamed" }, connection.id);
  expect((await connections.usage(connection.id)).rows[0]?.used).toBe(7);
  await connections.update({ secret: "replacement" }, connection.id);
  expect((await connections.usage(connection.id)).rows).toEqual([]);
  read.mockResolvedValue(absentUsage());
  expect((await connections.usage(connection.id, true)).rows).toEqual([]);
  secrets.clear(); expect((await connections.usage(connection.id)).rows).toEqual([]);
});
it("shares an idle diagnostic and lets an incoming chat claim the connection after cleanup", async () => {
  const { connections, connection } = await fixture(); let complete!: () => void;
  vi.spyOn(ClaudeHarnessAdapter.prototype, "readUsage").mockImplementation(() => new Promise(resolve => { complete = () => resolve(absentUsage()); }));
  const read = connections.usage(connection.id, true);
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  let claimed = false;
  const reserve = connections.reserve((await connections.binding(connection.id))!).then(release => { claimed = true; return release; });
  await Promise.resolve(); expect(claimed).toBe(false); complete(); await read;
  const release = await reserve; expect(claimed).toBe(true); release();
});

it("bounds idle native helpers across separate connections", async () => {
  const { connections, connection } = await fixture();
  const other = await connections.update({ name: "second", kind: "claude", auth: "claude-token", secret: "second" });
  const third = await connections.update({ name: "third", kind: "claude", auth: "claude-token", secret: "third" });
  const finish: Array<() => void> = [];
  const read = vi.spyOn(ClaudeHarnessAdapter.prototype, "readUsage").mockImplementation(() => new Promise(resolve => { finish.push(() => resolve(absentUsage())); }));
  const pending = [connections.usage(connection.id, true), connections.usage(other.id, true)];
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  expect(await connections.usage(third.id, true)).toMatchObject({ state: "unavailable", reason: "busy" });
  expect(read).toHaveBeenCalledTimes(2);
  for (const done of finish) done();
  await Promise.all(pending);
});


it("validates Core credentials before classifying API-key account telemetry as unsupported", async () => {
  const { connections, secrets } = await fixture();
  const connection = await connections.update({name:"API account",auth:"api-key",secret:"synthetic-api"});
  expect(await connections.usage(connection.id, true)).toMatchObject({state:"unsupported",reason:"unsupported_auth"});
  secrets.delete(connection.secretKey);
  expect(await connections.usage(connection.id, true)).toMatchObject({state:"unavailable",reason:"temporarily_unavailable",rows:[]});
});
