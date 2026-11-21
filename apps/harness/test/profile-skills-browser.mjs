// Runs against a parent-managed child Core, its installed Harness and its scripted native Codex provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticateHarness } from "./provider-browser.mjs";

const { chromium } = await import(process.env.HOSTY_PROFILE_PLAYWRIGHT_MODULE || "playwright");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
input = "";
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_PROFILE_BROWSER_CHANNEL || "chrome" });
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
  async function openChat(id) {
    const url = new URL(config.link);
    url.searchParams.set("session", id);
    url.searchParams.set("hosty_launch", "standalone");
    await page.goto(url.href);
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  }
  async function turn(id, action, reply, extra = {}) {
    const command = "PROFILE_SKILLS_ACCEPTANCE:" + JSON.stringify({ action, repository: config.repository, connectionId: config.connectionId, ...extra });
    await api("/sessions/" + id + "/messages", { clientRequestId: randomUUID(), text: command });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const session = await api("/sessions/" + id);
      if (session.status === "idle" && await page.getByText(reply, { exact: true }).isVisible()) return;
      if (["failed", "awaiting_approval", "awaiting_question", "cancelled", "abandoned"].includes(session.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Profile chat turn " + action + " did not finish: " + (await page.locator("main").innerText()).slice(-2400));
  }
  const before = await api("/profiles");
  const catalog = await api("/skills");
  const manager = await api("/sessions", { title: "Profile authoring", profileId: null, connectionId: config.connectionId, autonomy: "autonomous" });
  await openChat(manager.id);
  await turn(manager.id, "recommend", "I recommend fixture-review from the selected repository.");
  assert.deepEqual(await api("/profiles"), before);
  assert.deepEqual(await api("/skills"), catalog);
  // Simulate a Settings edit landing after the agent observed the directory, before its compound request.
  await api("/profiles", { expectedRevision: before.revision, profile: { name: "Concurrent settings edit",
    description: "", instructions: "", connectionId: null, model: null, reasoningEffort: null, skillIds: [] } });
  await turn(manager.id, "install", "Skill installed. The profile directory changed before saving.", { expectedRevision: before.revision });
  const library = (await api("/skills")).skills;
  const installed = library.find(skill => skill.name === "fixture-review");
  assert.equal(installed?.sourceKind, "git");
  assert.equal(installed?.commit, config.commit);
  assert.equal(installed.path, "skills/fixture-review");
  assert.ok(!library.some(skill => skill.name === "fixture-other"));
  const name = "Chat fixture reviewer";
  assert.ok(!(await api("/profiles")).profiles.some(profile => profile.name === name));
  await turn(manager.id, "create", "Created the reviewer with the installed skill.");
  const created = (await api("/profiles")).profiles.find(profile => profile.name === name);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.skillIds, [installed.id]);
  const oldChat = await api("/sessions", { profileId: created.id, profileRevision: created.revision });
  await openChat(oldChat.id);
  await turn(oldChat.id, "snapshot", "Snapshot chat started.");
  assert.equal((await api("/sessions/" + oldChat.id)).profileLocked, true);
  await openChat(manager.id);
  await turn(manager.id, "edit", "Updated the reviewer instructions.");
  const edited = (await api("/profiles")).profiles.find(profile => profile.id === created.id);
  assert.deepEqual(edited, { ...created, revision: 2, instructions: "Review the change and its tests." });
  assert.deepEqual((await api("/sessions/" + oldChat.id)).agentProfile, created);
  const newChat = await api("/sessions", { profileId: edited.id, profileRevision: edited.revision });
  assert.deepEqual((await api("/sessions/" + newChat.id)).agentProfile, edited);

  const settings = await context.newPage();
  await settings.goto(config.harness + "/settings/skills/?hosty_launch=standalone");
  const row = settings.getByRole("article").filter({ has: settings.getByRole("heading", { name: "fixture-review", exact: true }) });
  await row.getByText("Git · " + config.repository + " · main · " + config.commit.slice(0, 12), { exact: true }).waitFor();
  await settings.goto(config.harness + "/settings/profiles/?hosty_launch=standalone");
  await settings.getByRole("button", { name: "Edit " + name, exact: true }).click();
  const form = settings.getByRole("dialog");
  assert.equal(await form.getByLabel("Role instructions").inputValue(), edited.instructions);
  assert.equal(await form.getByLabel("Agent connection").inputValue(), config.connectionId);
  const selected = form.getByRole("checkbox", { name: /fixture-review/ });
  await selected.waitFor();
  assert.equal(await selected.isChecked(), true);
  console.log("PASS: authorized chat MCP, recommendation-only read, exact Git install, stale save recovery, shared profile edits, retained chat snapshots and Settings");
} finally {
  await browser.close();
}
