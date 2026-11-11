import { afterEach, beforeEach, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AuditReporter } from "../audit.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { createGatewayServer } from "../server.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { captureEnv } from "../test-env.js";
import type { PromptTemplateDirectory } from "./types.js";

const route = "/api/preferences/prompt-templates";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const entry = () => ({ id: randomUUID(), name: "Pull request", shortcut: "pr", text: "Review @literal /literal\nПривет" });
let directory: string, origin: string, server: Server, core: Server, manager: SessionManager, adapter: FakeHarnessAdapter, restore: () => void;
async function listen(value: Server): Promise<string> {
  await new Promise<void>(resolve => value.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(value.address() as AddressInfo).port}`;
}
const close = (value: Server) => new Promise<void>((resolve, reject) => value.close(error => error ? reject(error) : resolve()));
function request(user = "owner", method = "GET", body?: unknown, source = origin) {
  return fetch(origin + route, { method, headers: { cookie: `hosty_harness_identity=fixture-${user}`, origin: source, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "harness-prompt-templates-api-"));
  core = createServer(async (incoming, response) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const input = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as { accessToken?: string };
    response.setHeader("content-type", "application/json");
    const user = input.accessToken?.replace(/^fixture-/, "");
    response.end(JSON.stringify(user && ["owner", "other", "viewer"].includes(user)
      ? { active: true, userId: user, hostRole: user === "viewer" ? "host.user" : "host.admin" } : { active: false }));
  });
  const coreOrigin = await listen(core);
  restore = captureEnv({ HOSTY_APP_ID: "hosty.harness", HOSTY_CORE_ORIGIN: coreOrigin, HOSTY_APP_SERVICE_TOKEN: "prompt-template-test-service",
    HOSTY_DELEGATED_TOKEN_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).toString("base64") });
  adapter = new FakeHarnessAdapter();
  manager = new SessionManager(new SessionStore(directory), adapter, new AuditReporter(null, null, "hosty.harness"), directory);
  server = createGatewayServer(manager, adapter); origin = await listen(server);
});
afterEach(async () => { await manager.shutdown(); await close(server); await close(core); restore(); await rm(directory, { recursive: true, force: true }); });

it("requires an administrator app session rather than anonymous, ordinary or delegated clients", async () => {
  expect((await fetch(origin + route)).status).toBe(401);
  expect((await request("viewer")).status).toBe(401);
  expect((await request("unknown")).status).toBe(401);
  const payload = Buffer.from(JSON.stringify({ sub: "owner", role: "host.admin", aud: "hosty.harness", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: "test" })).toString("base64url");
  const input = `hosty_delegated.1.${payload}`;
  const delegated = `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  const refused = await fetch(origin + route, { headers: { authorization: `Bearer ${delegated}` } });
  expect(refused.status).toBe(403); expect(await refused.json()).toMatchObject({ code: "app_session_required" });
});

it("requires same-origin proof for cookie writes and exposes uncached reads", async () => {
  const body = { revision: 0, requestId: randomUUID(), templates: [entry()] };
  const rejected = await request("owner", "PUT", body, "https://foreign.example");
  expect(rejected.status).toBe(403); expect(await rejected.json()).toMatchObject({ code: "cross_site_request_blocked" });
  const missingOrigin = await fetch(origin + route, { method: "PUT", headers: { cookie: "hosty_harness_identity=fixture-owner", "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(missingOrigin.status).toBe(403);
  const initial = await request(); expect(initial.headers.get("cache-control")).toBe("no-store");
  expect(await initial.json()).toEqual({ revision: 0, templates: [] });
  const accepted = await request("owner", "PUT", body); expect(accepted.status).toBe(200); expect(accepted.headers.get("cache-control")).toBe("no-store");
});

it("keeps each administrator's collection private even when template IDs coincide", async () => {
  const template = entry();
  const owner = { revision: 0, requestId: randomUUID(), templates: [template] };
  expect((await request("owner", "PUT", owner)).status).toBe(200);
  expect(await (await request("other")).json()).toEqual({ revision: 0, templates: [] });
  const other = { revision: 0, requestId: owner.requestId, templates: [{ ...template, text: "Other user's text" }] };
  expect((await request("other", "PUT", other)).status).toBe(200);
  expect(await (await request()).json()).toEqual({ revision: 1, templates: [template] });
  expect((await request("other", "PUT", { ...other, revision: 1, requestId: randomUUID(), userId: "owner" })).status).toBe(400);
  expect((await request("owner", "PUT", { revision: 1, requestId: randomUUID(), templates: [] })).status).toBe(200);
  expect(await (await request("other")).json()).toMatchObject({ templates: [{ text: "Other user's text" }] });
});

it("persists revision conflicts and exact save replay across gateway recreation", async () => {
  const first = { revision: 0, requestId: randomUUID(), templates: [entry()] };
  expect((await request("owner", "PUT", first)).status).toBe(200);
  const second = { revision: 1, requestId: randomUUID(), templates: [{ ...first.templates[0]!, text: "More recent edit" }] };
  const latest = await (await request("owner", "PUT", second)).json() as PromptTemplateDirectory;
  await close(server); server = createGatewayServer(manager, adapter); origin = await listen(server);
  expect(await (await request()).json()).toEqual(latest);
  expect(await (await request("owner", "PUT", first)).json()).toEqual(latest);
  const reused = await request("owner", "PUT", { ...first, templates: [] });
  expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ code: "prompt_template_request_reused" });
  const stale = await request("owner", "PUT", { ...first, requestId: randomUUID() });
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "prompt_templates_changed" });
  expect(await (await request()).json()).toEqual(latest);
});

it("rejects invalid collections and oversized JSON without changing saved templates", async () => {
  const template = entry();
  const invalid = await request("owner", "PUT", { revision: 0, requestId: randomUUID(), templates: [template, { ...entry(), shortcut: "PR" }] });
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "prompt_templates_invalid" });
  const oversized = await request("owner", "PUT", { revision: 0, requestId: randomUUID(), templates: [entry()], padding: "p".repeat(512 * 1024) });
  expect(oversized.status).toBe(413);
  expect(await (await request()).json()).toEqual({ revision: 0, templates: [] });
  expect((await request("owner", "POST", {})).status).toBe(405);
});
