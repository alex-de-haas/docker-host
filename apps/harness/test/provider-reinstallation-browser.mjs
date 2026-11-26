// Real managed child Core, Harness UI and configured provider. Disposable credentials arrive on stdin.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticateHarness } from "./provider-browser.mjs";

const { chromium } = await import(process.env.HOSTY_RECOVERY_PLAYWRIGHT_MODULE || "playwright");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const browser = await chromium.launch({ channel: process.env.HOSTY_RECOVERY_BROWSER_CHANNEL || "chrome", headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.core + "/login?returnTo=%2Fapi%2Fauth%2Fsession");
  const core = new URL(page.url()).origin;
  await page.getByLabel("Email", { exact: true }).fill("activation-fixture@example.test");
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === "/login" && r.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  const identity = await (await context.request.get(core + "/api/auth/session")).json();
  assert.equal(identity.authenticated, true);
  const { token } = await (await context.request.get(core + "/api/auth/csrf")).json();
  await authenticateHarness(context, core, token, config);

  const sessionPath = "/api/sessions/" + encodeURIComponent(config.chatId);
  async function binding() {
    const response = await context.request.get(config.harness + sessionPath);
    assert.equal(response.status(), 200);
    const { id, createdBy, connectionId, connectionRevision, selection, selectionRevision, executionSelection, providerExecution, contextChanges } = await response.json();
    assert.equal(id, config.chatId);
    assert.equal(createdBy, identity.user.id);
    assert.equal(providerExecution.run.stopConfirmed, true);
    assert.equal(providerExecution.run.phase, "terminal");
    return { connectionId, connectionRevision, selection, selectionRevision, executionSelection,
      sessionId: providerExecution.sessionId, runId: providerExecution.runId, contextChanges };
  }
  const before = await binding();
  assert.notEqual(before.connectionId, config.connectionId);
  const mutations = [];
  page.on("request", request => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
    const path = new URL(request.url()).pathname;
    if ([sessionPath + "/context", sessionPath + "/model", sessionPath + "/provider", sessionPath + "/messages"].includes(path)
      || path.startsWith(sessionPath + "/message-queue") || path.startsWith("/api/agent/v2/")) mutations.push(path);
  });

  await page.goto(config.harness + "/chats/?session=" + encodeURIComponent(config.chatId));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Unsent recovery draft " + randomUUID();
  await page.getByText(config.lastUserMessage, { exact: true }).last().waitFor();
  await composer.fill(draft);
  await page.getByRole("button", { name: /^Agent settings:/ }).click();
  await page.getByRole("button", { name: "Change session context…" }).click();
  const dialog = page.getByRole("dialog", { name: "Change session context" });
  const account = dialog.getByRole("combobox", { name: /^Connection/ });
  await account.selectOption(config.connectionId);
  const model = dialog.getByRole("combobox", { name: /^Model/ });
  await model.selectOption(config.model);
  const accountName = await account.locator("option:checked").innerText();
  const modelName = await model.locator("option:checked").innerText();
  assert.equal(await dialog.getByRole("button", { name: "Review verified resume" }).count(), 0);
  await dialog.getByRole("button", { name: "Review fresh start" }).click();

  const confirm = page.getByRole("dialog", { name: "Start a new context?" });
  await confirm.getByText(accountName + " · " + modelName, { exact: true }).waitFor();
  await confirm.getByText(/earlier messages stay visible.*no prior conversation history/i).waitFor();
  await confirm.getByRole("button", { name: "Start new context", exact: true }).waitFor();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), draft);
  assert.deepEqual(await binding(), before);
  assert.deepEqual(mutations, [], "Preview and Cancel must not submit settings, a turn or a native command.");
  console.log("PASS: owner opened the existing chat after data loss, reviewed the current account and model, saw the fresh-context warning, and cancelled with the binding and draft intact.");
} finally {
  await browser.close();
}
