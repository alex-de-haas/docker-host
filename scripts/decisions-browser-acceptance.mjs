import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function checkDecisions({ page, context, config, csrf }) {
  await page.goto(config.harness + "/decisions/");
  await page.getByRole("heading", { name: /^Decisions/ }).waitFor();
  const create = async title => {
    csrf = await (await page.request.get(config.core + "/api/auth/csrf")).json();
    const response = await page.request.post(config.core + "/api/decisions/v1/requests", {
      headers: { Origin: config.core, "X-Hosty-CSRF": csrf.token },
      data: { requestId: randomUUID(), input: { correlationKey: randomUUID(), title, questions: [
        { id: "first", question: "Choose approach", options: [{ id: "a", label: "Same label", description: "First" }, { id: "b", label: "Same label", description: "Second" }], allowText: false },
        { id: "second", question: "Explain approach", allowText: true },
      ] } },
    });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const title = "Browser decision acceptance " + randomUUID();
  const row = await create(title);
  // This record has no Harness wait: only the authorized Core stream can discover it live.
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("heading", { name: row.input.title, exact: true }).waitFor();
  assert.equal(await page.locator("input:checked").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Submit answer", exact: true }).isDisabled(), true);
  await page.getByRole("radio").nth(1).check();
  await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("Retained explicit answer");
  await page.reload();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  assert.equal(await page.getByRole("textbox", { name: "Your answer", exact: true }).inputValue(), "Retained explicit answer");
  assert.equal(await page.getByRole("radio").nth(1).isChecked(), true);
  const other = await context.newPage();
  try {
    await other.goto(config.harness + "/decisions/?decision=" + row.id);
    await other.getByRole("heading", { name: row.input.title, exact: true }).waitFor();
    await page.getByRole("button", { name: "Submit answer", exact: true }).click();
    await page.getByText("Answer saved", { exact: false }).waitFor();
    await other.getByText("Answer saved", { exact: false }).waitFor();
    const current = await (await page.request.get(config.harness + "/api/decisions/" + row.id)).json();
    assert.deepEqual(current.resolution.answers.first.optionIds, ["b"]);
    assert.equal(current.resolution.answers.second.text, "Retained explicit answer");
    assert.equal(current.continuation.state, "pending"); // An answer cannot invent a source executor.
    csrf = await (await page.request.get(config.core + "/api/auth/csrf")).json();
    const losing = await page.request.post(config.core + "/api/decisions/v1/requests/" + row.id + "/resolve", {
      headers: { Origin: config.core, "X-Hosty-CSRF": csrf.token },
      data: { requestId: randomUUID(), expectedRevision: row.revision, answers: { first: { optionIds: ["a"] }, second: { text: "Late answer" } } },
    });
    assert.equal(losing.status(), 409, await losing.text());
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(title) }).waitFor();
    await page.setViewportSize({ width: 1320, height: 950 });
  } finally { await other.close(); }
  await page.getByRole("button", { name: "Needs attention", exact: true }).click();
  const identity = await (await page.request.get(config.harness + "/api/auth/identity")).json();
  const taskTitle = "Decision review acceptance " + randomUUID();
  const made = await page.request.post(config.harness + "/api/tasks/v1/tasks", {
    headers: { Origin: config.harness }, data: { requestId: randomUUID(), input: {
      title: taskTitle, markdown: "Review the existing task through Decisions.",
      assignee: { kind: "human", userId: identity.userId }, review: { mode: "owner" }, resources: [],
    } },
  });
  assert.equal(made.status(), 201, await made.text());
  let task = await made.json();
  for (const action of ["ready", "start", "complete"]) {
    const response = await page.request.post(config.harness + "/api/tasks/v1/tasks/" + task.ref.id + "/actions", {
      headers: { Origin: config.harness }, data: { requestId: randomUUID(), expectedRevision: task.revision, action,
        ...(action === "complete" ? { result: { markdown: "Reviewed result", resources: [] } } : {}) },
    });
    assert.equal(response.status(), 200, await response.text()); task = await response.json();
  }
  assert.equal(task.blocked.reason, "needs_review");
  await page.getByRole("button", { name: new RegExp(taskTitle) }).click();
  await page.getByRole("button", { name: "Accept result", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(taskTitle) }).waitFor({ state: "hidden" });
  const accepted = await (await page.request.get(config.harness + "/api/tasks/v1/tasks/" + task.ref.id)).json();
  assert.equal(accepted.status, "Done");
  assert.equal(accepted.attempts.length, 0);
  if (config.shell) {
    const embeddedTitle = "Embedded decision acceptance " + randomUUID();
    const embedded = await create(embeddedTitle);
    await page.goto(config.shell + "/workspace?app=hosty.harness&path=%2Fdecisions");
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: /^Decisions/ }).waitFor();
    await frame.getByRole("button", { name: new RegExp(embeddedTitle) }).click();
    await frame.getByRole("radio").nth(1).check();
    await frame.getByRole("textbox", { name: "Your answer", exact: true }).fill("Answered inside Shell");
    await frame.getByRole("button", { name: "Submit answer", exact: true }).click();
    await frame.getByText("Answer saved", { exact: false }).waitFor();
    const saved = await (await page.request.get(config.core + "/api/decisions/v1/requests/" + embedded.id)).json();
    assert.equal(saved.resolution.answers.second.text, "Answered inside Shell");
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.HOSTY_DECISIONS_SCREENSHOT) await page.screenshot({ path: process.env.HOSTY_DECISIONS_SCREENSHOT, fullPage: true });
    console.log("PASS: normal Shell login/navigation, embedded Decisions response and no document overflow");
  }
  console.log("PASS: Decisions task review resolves the authoritative task without creating another attempt");
  console.log("PASS: Decisions Core event delivery, explicit selection/free text, draft reload, two views, conflicting client, separate continuation and narrow layout");
}
