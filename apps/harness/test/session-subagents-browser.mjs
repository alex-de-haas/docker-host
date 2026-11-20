// Run against the isolated Core, its installed Harness and the scripted native Codex provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticateHarness } from "./provider-browser.mjs";

const { chromium } = await import(process.env.HOSTY_SUBAGENTS_PLAYWRIGHT_MODULE || "playwright");
let command = "";
for await (const chunk of process.stdin) command += chunk;
const config = JSON.parse(command);
command = "";
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_SUBAGENTS_BROWSER_CHANNEL || "chrome" });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.core + "/login?returnTo=%2Fapi%2Fauth%2Fsession");
  const core = new URL(page.url()).origin;
  await page.getByLabel("Email", { exact: true }).fill(config.email);
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  config.password = "";
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/login" && r.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  const csrf = await (await context.request.get(core + "/api/auth/csrf")).json();
  await authenticateHarness(context, core, csrf.token, config);
  async function api(route, data) {
    const response = await context.request.fetch(config.harness + "/api" + route, {
      method: data ? "POST" : "GET", headers: { Origin: config.harness }, data,
    });
    assert.ok(response.ok(), route + " returned " + response.status());
    return response.json();
  }
  for (const role of ["developer", "tester"]) {
    const profiles = await api("/profiles");
    await api("/profiles", { expectedRevision: profiles.revision, profile: { name: "Family fixture " + role,
      description: "Isolated handoff verification", instructions: "Act as the assigned " + role + ".",
      connectionId: config.connectionId, model: null, reasoningEffort: null, skillIds: [] } });
  }
  const parent = await api("/sessions", { title: "Profile handoff", profileId: null, connectionId: config.connectionId, autonomy: "autonomous" });
  const url = new URL(config.link);
  url.searchParams.set("session", parent.id);
  url.searchParams.set("hosty_launch", "standalone");
  await page.goto(url.href);
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await api("/sessions/" + parent.id + "/messages", { clientRequestId: randomUUID(), text: "CHAT_FAMILY_ACCEPTANCE:ORCHESTRATE" });
  try {
    await page.getByText("Family fixture handoff verified.", { exact: true }).waitFor({ timeout: 120000 });
  } catch (error) {
    const record = await api("/sessions/" + parent.id);
    console.error("Family handoff state", JSON.stringify({ status: record.status,
      children: record.subagents?.map(c => ({ role: c.profileName, status: c.status, result: c.result })) }));
    const transcript = await page.locator("main").innerText().catch(() => "");
    console.error("Fixture transcript", transcript.slice(-3200));
    throw error;
  }
  const retained = await api("/sessions/" + parent.id);
  assert.deepEqual(retained.subagents.map(c => [c.profileName, c.status]), [
    ["Family fixture developer", "completed"], ["Family fixture tester", "completed"],
  ]);
  for (const child of retained.subagents) {
    const record = await api("/sessions/" + child.id);
    assert.equal(record.parentSessionId, parent.id);
    assert.equal(record.createdBy, parent.createdBy);
    assert.equal(record.taskExecutionId, undefined);
    assert.equal(record.agentProfile.id, child.profileId);
  }
  for (const role of ["developer", "tester"]) {
    const profile = "Family fixture " + role;
    const child = retained.subagents.find(row => row.profileName === profile);
    const group = page.getByRole("region", { name: "Harness subagents" }).filter({ hasText: /subagent/ });
    for (const row of await group.all()) {
      const toggle = row.getByRole("button", { name: /^\d+ subagent/ });
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    }
    const row = group.filter({ has: page.getByRole("button", { name: profile + ": Completed. Show output" }) });
    await row.getByRole("button", { name: profile + ": Completed. Show output" }).click();
    await row.getByText(child.result, { exact: true }).waitFor();
    await row.getByRole("link", { name: "Open chat" }).click();
    await page.getByRole("link", { name: "Parent chat" }).waitFor();
    await page.getByText(child.result, { exact: true }).waitFor();
    await page.getByRole("link", { name: "Parent chat" }).click();
    await page.getByText("Family fixture handoff verified.", { exact: true }).waitFor();
  }
  console.log(JSON.stringify([parent.id, ...retained.subagents.map(child => child.id)]));
} finally { await browser.close(); }
