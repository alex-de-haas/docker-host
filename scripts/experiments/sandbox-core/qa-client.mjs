// Core-managed acceptance fixture. It contains no workspace/session API and no agent dependency.
// Build @hosty-sdk/app first. Install this directory's manifest into an isolated test Core only.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SandboxClient, sandboxActions } from "../../../packages/app-sdk/dist/sandbox-server.js";
import { BackgroundGrantClient } from "../../../packages/app-sdk/dist/background-server.js";

const jobs = new Map();
const port = Number(process.env.HOSTY_PORT_HTTP);
if (!port || !process.env.HOSTY_APP_SERVICE_TOKEN) throw new Error("Start this fixture through Core.");
function reply(res, status, value) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return reply(res, 200, { status: "ok" });
  try {
    if (req.method === "POST" && req.url === "/api/app-code") {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return reply(res, 413, { code: "input_too_large" }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks));
      const response = await fetch(new URL("/api/auth/apps/token", process.env.HOSTY_CORE_ORIGIN), {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${process.env.HOSTY_APP_SERVICE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ code: input.code, codeVerifier: input.codeVerifier }), signal: AbortSignal.timeout(10000),
      });
      return reply(res, response.status, await response.json());
    }
    // This fixture deliberately requires an app-bound Core user token. Cookies, Core passwords,
    // service credentials and a model's claimed actor ID cannot stand in for it.
    const credential = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    if (!credential.startsWith("hostyg_")) return reply(res, 401, { code: "app_grant_required" });
    const validated = await fetch(new URL("/api/auth/apps/revalidate", process.env.HOSTY_CORE_ORIGIN), {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${process.env.HOSTY_APP_SERVICE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ accessToken: credential }), signal: AbortSignal.timeout(10000),
    });
    if (!validated.ok) return reply(res, 403, { code: "app_grant_invalid" });
    const actor = await validated.json();
    if (!actor.active || actor.hostRole !== "host.admin") return reply(res, 403, { code: "administrator_required" });
    if (req.method === "GET" && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(req.url)) {
      const job = jobs.get(req.url.slice("/api/jobs/".length));
      if (!job || job.owner !== actor.userId) return reply(res, 404, { code: "not_found" });
      const { owner, ...view } = job;
      return reply(res, 200, view);
    }
    if (req.method !== "POST" || !["/api/sandbox", "/api/jobs"].includes(req.url)) return reply(res, 404, { code: "not_found" });
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) return reply(res, 413, { code: "input_too_large" }); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks));
    if (!sandboxActions.includes(input.action)) return reply(res, 400, { code: "action_invalid" });
    // Background IDs are references only: Core authenticates this installation and validates the
    // separately approved grant on every call. The HTTP caller is still authenticated above.
    const background = input.background ? new BackgroundGrantClient(input.background.grantId, input.background.scopeId) : null;
    const client = new SandboxClient(() => background ? background.token() : Promise.resolve(credential));
    if (req.url === "/api/jobs") {
      if (!background) return reply(res, 400, { code: "background_grant_required" });
      for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > 600000) jobs.delete(id);
      if (jobs.size >= 32 || [...jobs.values()].some(job => job.state === "running" || job.state === "scheduled"))
        return reply(res, 409, { code: "fixture_busy" });
      const job = { id: randomUUID(), owner: actor.userId, state: "scheduled", acceptedAt: Date.now() };
      jobs.set(job.id, job);
      // Acceptance starts this bounded job, logs out, and closes its interactive connection.
      // The delayed dispatch obtains only the separately approved background credential.
      setTimeout(async () => {
        job.state = "running"; job.startedAt = Date.now();
        try { job.result = await client.call(input.action, input.input ?? {}); job.state = "succeeded"; }
        catch (error) { job.state = "failed"; job.error = { code: error.code ?? "fixture_failed", status: error.status ?? 500 }; }
        finally { job.finishedAt = Date.now(); }
      }, 5000);
      return reply(res, 202, { id: job.id, state: job.state });
    }
    reply(res, 200, await client.call(input.action, input.input ?? {}));
  } catch (error) { reply(res, error.status ?? 500, { code: error.code ?? "fixture_failed", message: error.code ? error.message : "The QA fixture failed." }); }
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
