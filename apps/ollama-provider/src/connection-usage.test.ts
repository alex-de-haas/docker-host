import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OllamaConnections } from "./connections.js";
let connections: OllamaConnections, root: string;
async function fixture() { root=await mkdtemp(path.join(os.tmpdir(),"ollama-usage-"));connections=new OllamaConnections(root,root,{get:async()=>null,set:async()=>{},delete:async()=>{}});return {connections}; }
afterEach(async()=>{await connections?.shutdown();if(root)await rm(root,{recursive:true,force:true});});
it("reports local Ollama quota as not applicable without credentials or network diagnostics", async () => {
  const { connections } = await fixture();
  const connection = await connections.update({ name: "local", kind: "ollama", auth: "none" });
  const adapter = vi.spyOn(connections, "adapter");
  for (const refresh of [false, true]) expect(await connections.usage(connection.id, refresh)).toMatchObject({
    state: "not_applicable", reason: "local", rows: [], connectionRevision: connection.revision,
  });
  expect(adapter).not.toHaveBeenCalled();
  await connections.update({ baseUrl: "http://localhost:11435" }, connection.id);
  expect((await connections.usage(connection.id)).connectionRevision).toBeGreaterThan(connection.revision);
});
