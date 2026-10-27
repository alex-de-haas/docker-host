import { afterEach, beforeEach, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ProfileDirectory } from "./types.js";
import type { SessionRecord } from "../sessions/store.js";
import { ProfileStore } from "./store.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { SettingsStore } from "../settings/store.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { createGatewayServer } from "../server.js";
import { captureEnv } from "../test-env.js";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
function token(sub = "admin", role = "host.admin") {
  const body = Buffer.from(JSON.stringify({ sub, role, aud: "hosty.harness", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 300, jti: "test" })).toString("base64url");
  const input = `hosty_delegated.1.${body}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const profile = { name: "Planner", description: "Plan work", instructions: "Plan first", connectionId: null, model: null, reasoningEffort: null, skillIds: [] };
let dir: string, origin: string, restore: () => void, server: Server, manager: SessionManager;
const request = (route: string, method = "GET", body?: unknown, credential = token()) => fetch(origin + route, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-profiles-api-"));
  restore = captureEnv({ HOSTY_APP_ID: "hosty.harness", HOSTY_DELEGATED_TOKEN_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).toString("base64"), HOSTY_CORE_ORIGIN: undefined, HOSTY_APP_SERVICE_TOKEN: undefined });
  const settings = new SettingsStore(dir), adapter = new FakeHarnessAdapter();
  manager = new SessionManager(new SessionStore(dir), adapter, new AuditReporter(null, null, "hosty.harness"), dir, settings, null, null, null, null, null, null, null, null, undefined, new ProfileStore(dir, async () => profile, async () => []));
  server = createGatewayServer(manager, adapter, settings);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await manager.shutdown(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); restore(); await rm(dir, { recursive: true, force: true }); });
it("shares profile administration across admins but refuses ordinary users and unsigned requests", async () => {
  for (const credential of ["", "hosty_provider.synthetic", token("user", "host.user")]) expect((await request("/api/profiles", "GET", undefined, credential)).status).toBe(401);
  const response = await request("/api/profiles"); expect(response.headers.get("cache-control")).toBe("no-store");
  const state = await response.json() as ProfileDirectory;
  const created = await request("/api/profiles", "POST", { expectedRevision: state.revision, profile: { ...profile, name: "Reviewer" } }, token("another-admin"));
  expect(created.status).toBe(201); expect((await created.json() as ProfileDirectory).profiles).toHaveLength(2);
  expect((await request("/api/profiles", "POST", { expectedRevision: state.revision, profile: { ...profile, name: "Stale" } })).status).toBe(409);
});
it("keeps session profile changes owner-bound and refuses resource or permission fields", async () => {
  const session = await (await request("/api/sessions", "POST", {})).json() as SessionRecord;
  const change = { profileId: null, expectedRevision: 0 };
  expect((await request(`/api/sessions/${session.id}/profile`, "PUT", change, token("another-admin"))).status).toBe(404);
  expect((await request(`/api/sessions/${session.id}/profile`, "PUT", change)).status).toBe(200);
  const state = await (await request("/api/profiles")).json() as ProfileDirectory;
  expect((await request("/api/profiles", "POST", { expectedRevision: state.revision, profile: { ...profile, permissions: ["all"] } })).status).toBe(400);
  expect((await request("/api/settings", "PUT", { skillIds: [] })).status).toBe(409);
});
