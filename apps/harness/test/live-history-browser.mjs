// Repeated disconnects in a managed child. Fixture journal reads establish source positions and
// verify that a single rendered message also corresponds to a single durable Harness record.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

const { chromium } = await import(process.env.HOSTY_HISTORY_PLAYWRIGHT_MODULE || "playwright");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
input = "";
const execute = promisify(execFile);
const browser = await chromium.launch({ channel: process.env.HOSTY_HISTORY_BROWSER_CHANNEL || "chrome", headless: true });
const archive = new DatabaseSync(path.join(config.root, "apps", config.provider, "data", "agent-sessions", "execution-v2.sqlite"), { readOnly: true });
archive.exec("PRAGMA busy_timeout=3000");
const requests = new Map();
const native = createServer((request, response) => {
  if (!/^\/[0-9a-f]{32}\/\d+$/.test(request.url)) { response.writeHead(404).end(); return; }
  requests.set(request.url, response);
});
native.listen(0, "127.0.0.1");
await once(native, "listening");

async function eventually(fn, description) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await wait(60);
  }
  throw new Error("Timed out waiting for " + description);
}
async function json(response) {
  assert.ok(response.ok(), new URL(response.url()).pathname + " HTTP " + response.status());
  return response.json();
}
async function signIn(email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.core + "/login?returnTo=%2Fapi%2Fauth%2Fsession");
  const core = new URL(page.url()).origin;
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/login" && r.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  const identity = await json(await context.request.get(core + "/api/auth/session"));
  assert.ok(identity.authenticated);
  const { token } = await json(await context.request.get(core + "/api/auth/csrf"));
  const verifier = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const { code } = await json(await context.request.post(core + "/api/apps/" + config.app + "/launch-code", {
    headers: { Origin: core, "X-Hosty-CSRF": token },
    data: { redirectUri: config.link, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256" }
  }));
  await json(await context.request.post(config.harness + "/api/auth/app-code", {
    headers: { Origin: config.harness }, data: { code, codeVerifier: verifier }
  }));
  await page.close();
  return { context, user: identity.user.id };
}
const sessionUrl = id => config.harness + "/api/sessions" + (id ? "/" + id : "");
async function openChat(owner) {
  const key = randomUUID().replaceAll("-", "");
  const session = await json(await owner.context.request.post(sessionUrl(), {
    headers: { Origin: config.harness }, data: { connectionId: config.connection, title: "Range recovery " + key.slice(0, 8) }
  }));
  const page = await owner.context.newPage();
  const streamStatuses = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/sessions/" + session.id + "/events")
      streamStatuses.push(response.status());
  });
  const url = new URL(config.harness + "/assistant/");
  url.searchParams.set("session", session.id);
  url.searchParams.set("hosty_launch", "standalone");
  await page.goto(url.href);
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await json(await owner.context.request.post(sessionUrl(session.id) + "/messages", { headers: { Origin: config.harness },
    data: { text: "HISTORY_RANGES:" + native.address().port + ":" + key, clientRequestId: randomUUID() } }));
  await eventually(() => requests.has("/" + key + "/0"), "native run " + key);
  const current = await json(await owner.context.request.get(sessionUrl(session.id)));
  assert.ok(current.providerExecution.sessionId);
  return { page, owner, key, id: session.id, providerSession: current.providerExecution.sessionId, texts: [], streamStatuses, batch: 0 };
}
async function emit(chat, labels, done = false) {
  const key = "/" + chat.key + "/" + chat.batch++;
  const response = await eventually(() => requests.get(key), "next native fixture request");
  const messages = labels.map(label => "GAP-CHECK-" + chat.key.slice(0, 8) + "-" + label);
  chat.texts.push(...messages);
  assert.equal(response.destroyed, false, "controlled native peer remains connected");
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ messages, done }));
  const last = messages.at(-1);
  if (last) {
    try {
      await eventually(() => archive.prepare(
        "SELECT 1 FROM history_facts WHERE session=? AND json_extract(body,'$.item.event.data.text')=? LIMIT 1"
      ).get(chat.providerSession, last), "provider commit for " + last);
    } catch (error) {
      const latest = await json(await chat.owner.context.request.get(sessionUrl(chat.id)));
      console.error("Native batch", chat.batch, "acknowledged", requests.has("/" + chat.key + "/" + chat.batch),
        "archived session", archive.prepare("SELECT session FROM history_facts WHERE json_extract(body,'$.item.event.data.text')=?").get(last),
        "expected session", chat.providerSession, "current session", latest.providerExecution?.sessionId, "status", latest.status);
      throw error;
    }
  }
  return messages;
}
async function policy(rules) {
  const tmp = config.policy + ".tmp";
  await writeFile(tmp, JSON.stringify(rules), { mode: 0o600 });
  await rename(tmp, config.policy);
}
async function lifecycle(action, session) {
  await execute(config.cli, ["--data-root", config.root, "apps", action, config.app], { timeout: 120_000 });
  if (action === "start") await eventually(async () => {
    try { return (await session.owner.context.request.get(sessionUrl(session.id), { timeout: 2000 })).ok(); }
    catch { return false; }
  }, "healthy Harness after restart");
}
const marker = chat => chat.page.locator("[data-history-gap-from][data-history-gap-to]");
const visible = async (chat, text) => chat.page.getByText(text, { exact: true }).waitFor({ state: "visible", timeout: 50_000 });
const rows = async chat => chat.page.evaluate(() =>
  Array.from(document.querySelectorAll("p")).map(row => row.textContent).filter(t => t.startsWith("GAP-CHECK-")));
const gapsIn = chat => marker(chat).evaluateAll(entries => entries.map(e => [Number(e.dataset.historyGapFrom), Number(e.dataset.historyGapTo)]));
async function awaitGaps(chat, count, accept = () => true) {
  try {
    return await eventually(async () => {
      const gaps = await gapsIn(chat);
      return gaps.length === count && accept(gaps) && gaps;
    }, `${count} visible gaps in ${chat.key}`);
  } catch (error) {
    const current = await json(await chat.owner.context.request.get(sessionUrl(chat.id)));
    console.error("Visible ranges", await gapsIn(chat), "backend ranges", current.providerHistoryGaps,
      "page", new URL(chat.page.url()).pathname, "visibility", await chat.page.evaluate(() => document.visibilityState),
      "stream responses", chat.streamStatuses);
    throw error;
  }
}
const ordinal = (chat, label) => archive.prepare(
  "SELECT ordinal FROM history_facts WHERE session=? AND json_extract(body,'$.item.event.data.text')=?"
).get(chat.providerSession, chat.texts.find(t => t.endsWith("-" + label))).ordinal;
try {
  const alice = await signIn("activation-fixture@example.test"), bob = await signIn("history-second@example.test");
  assert.notEqual(alice.user, bob.user);
  const chats = [];
  for (const owner of [alice, alice, bob]) {
    const chat = await openChat(owner);
    chats.push(chat);
    const [initial] = await emit(chat, ["BASELINE"]);
    await visible(chat, initial);
  }
  const [first] = chats;
  await lifecycle("stop", first);
  for (const chat of chats) await emit(chat, ["OLD-1", "OLD-2", "OLD-3", "OLD-4"]);
  // The provider also journals periodic usage. Let the page covering OLD-1 through, then hold
  // later pages regardless of how many usage samples landed during the restart.
  const old1 = ordinal(first, "OLD-1"), old2 = ordinal(first, "OLD-2"), old4 = ordinal(first, "OLD-4");
  await policy({ [first.providerSession]: { pageSize: 2, hold: [[old1 + 1, Number.MAX_SAFE_INTEGER]] } });
  await lifecycle("start", first);
  const [firstGap] = await awaitGaps(first, 1, ([[lo, hi]]) => lo > old1 && lo <= old2 && hi >= old4);
  await visible(first, first.texts.find(t => t.endsWith("-OLD-1")));
  console.log("PASS: partially recovered first range", JSON.stringify(firstGap));
  for (const chat of chats) {
    const [message] = await emit(chat, ["LIVE-ONE-DUPLICATE"]);
    await visible(chat, message);
    assert.equal(await chat.page.getByText(message, { exact: true }).count(), 1);
  }
  assert.equal(await marker(first).count(), 1);
  await lifecycle("stop", first);
  await policy({ [first.providerSession]: { hold: [[1, Number.MAX_SAFE_INTEGER]] } });
  for (const chat of chats) await emit(chat, ["OLD-5", "OLD-6"]);
  await lifecycle("start", first);
  const old5 = ordinal(first, "OLD-5"), old6 = ordinal(first, "OLD-6");
  const expectedGaps = await awaitGaps(first, 2, ([earlier, [lo, hi]]) =>
    earlier[0] === firstGap[0] && earlier[1] === firstGap[1] && lo > ordinal(first, "LIVE-ONE-DUPLICATE") && lo <= old5 && hi >= old6);
  for (const chat of chats) {
    const [message] = await emit(chat, ["LIVE-TWO-DUPLICATE"]);
    await visible(chat, message);
    assert.equal(await chat.page.getByText(message, { exact: true }).count(), 1);
  }
  assert.deepEqual(await awaitGaps(first, 2), expectedGaps);
  const visibleTimeline = await first.page.locator("p").evaluateAll(entries => entries.map(row =>
    row.hasAttribute("data-history-gap-from") ? "gap:" + row.dataset.historyGapFrom : row.textContent));
  const timelineOrder = [first.texts[0], "gap:" + expectedGaps[0][0], first.texts.find(t => t.endsWith("LIVE-ONE-DUPLICATE")),
    "gap:" + expectedGaps[1][0], first.texts.at(-1)].map(text => visibleTimeline.indexOf(text));
  assert.ok(timelineOrder.every((index, i) => index >= 0 && (i === 0 || index > timelineOrder[i - 1])),
    "each gap is displayed between the corresponding live messages");
  console.log("PASS: two visible historical gaps", JSON.stringify(expectedGaps), "while all three open chats render new live messages");
  await policy({ [first.providerSession]: { hold: [expectedGaps[0]] } });
  assert.deepEqual(await awaitGaps(first, 1), [expectedGaps[0]]);
  await visible(first, first.texts.find(t => t.endsWith("OLD-6")));
  await policy({});
  for (const chat of chats) {
    await awaitGaps(chat, 0);
    const [final] = await emit(chat, ["FINAL"], true);
    await visible(chat, final);
    assert.deepEqual(await rows(chat), chat.texts, "original order and exactly one copy in each chat");
    const other = chat.owner === alice ? bob : alice;
    assert.ok([403, 404].includes((await other.context.request.get(sessionUrl(chat.id))).status()));
    const run = await eventually(async () => {
      const latest = await json(await chat.owner.context.request.get(sessionUrl(chat.id)));
      return latest.providerExecution?.run?.stopConfirmed && latest.providerExecution.run;
    }, "final provider state");
    assert.equal(run.state, "succeeded");
    const db = new DatabaseSync(path.join(config.root, "apps", config.app, "data", "execution-v2", "sessions", chat.id, "chat.sqlite"), { readOnly: true });
    let events;
    try { events = db.prepare("SELECT body FROM transcript ORDER BY seq").all().map(row => JSON.parse(row.body)); } finally { db.close(); }
    const persisted = events
      .filter(event => event.type === "assistant_text" && event.text?.startsWith("GAP-CHECK-")).map(event => event.text);
    assert.deepEqual(persisted.sort(), [...chat.texts].sort(), "exactly one durable copy of each message for its chat owner");
  }
  console.log("PASS: later range recovered first, then full ordered transcripts with no duplicates, terminal state, and ownership isolation for two signed-in users and three chats");
} finally {
  native.closeAllConnections();
  native.close();
  archive.close();
  await browser.close();
}
