import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path"; import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { AgentConnections, type AgentConnection, type ConnectionBinding } from "./registry.js";
import type { HarnessAdapter } from "../harness/adapter.js";

const capabilities = { questions: true, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false };
const native: HarnessAdapter = { name: "independent-executor", capabilities, probe: async () => ({available:true}), start() { throw new Error("Metadata operations must not execute an agent."); } };
class IndependentConnections extends AgentConnections {
  readonly selected: ConnectionBinding[] = [];
  protected override async createAdapter(_connection: AgentConnection, binding: ConnectionBinding) { this.selected.push(binding); return native; }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "independent-connections-")), secrets = new Map<string,string>();
  cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const connections = new IndependentConnections(directory, path.join(directory,"cache"), {get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}},
    {kind:"org.example.engine",name:"Independent executor",capabilities,authMethods:{"custom-ticket":{credential:"required"}}});
  cleanup.push(()=>connections.shutdown());return {directory,secrets,connections};
}
it("persists opaque application engine/authentication identities without a native dependency", async()=>{
  const {directory,secrets,connections}=await fixture();
  const account=await connections.update({name:"Personal",auth:"custom-ticket",secret:"synthetic-ticket"});
  expect(account.kind).toBe("org.example.engine");expect((await connections.list()).defaultId).toBe(account.id);
  const binding=(await connections.binding(account.id))!;
  expect(await (await connections.prepareAdapter(binding,{skillPath:"unused",sessionDirectory:"unused"})).probe()).toEqual({available:true});
  expect(connections.selected).toEqual([binding]);
  expect(await readFile(path.join(directory,"connections.json"),"utf8")).not.toContain("synthetic-ticket");
  expect(secrets.get(account.secretKey)).toBe("synthetic-ticket");
  await expect(connections.update({name:"Foreign",kind:"another.engine",auth:"custom-ticket",secret:"ticket"})).rejects.toMatchObject({code:"provider_invalid"});
});
it("keeps account reservations and credential revision guards independent of the native engine", async()=>{
  const {connections}=await fixture(),account=await connections.update({name:"Personal",auth:"custom-ticket",secret:"ticket"});
  const binding=(await connections.binding(account.id))!,release=await connections.reserve(binding);
  expect((await connections.update({name:"Renamed"},account.id)).revision).toBe(account.revision);
  await expect(connections.update({secret:"replacement"},account.id)).rejects.toMatchObject({code:"provider_in_use"});
  release();expect((await connections.update({secret:"replacement"},account.id)).revision).toBe(2);
  await expect(connections.adapter(binding)).rejects.toMatchObject({code:"provider_credentials_changed"});
});
