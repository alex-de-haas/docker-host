// Real child-Core password login, app-code exchange, Shell embedding and deterministic speech.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
const { chromium } = await import(process.env.HOSTY_SPEECH_PLAYWRIGHT_MODULE || "playwright");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
input = "";
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_SPEECH_BROWSER_CHANNEL || "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + config.wav] });
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.grantPermissions(["microphone"], { origin: config.harness });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(60_000);
  await page.goto(config.core + "/login?returnTo=%2Faccount%2Ftokens");
  const core = new URL(page.url()).origin;
  await page.getByLabel("Email", { exact: true }).fill(config.email);
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  config.password = "";
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/login" && r.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  const json = async r => { assert.ok(r.ok(), r.status() + " " + new URL(r.url()).pathname); return r.json(); };
  assert.equal((await json(await page.request.get(core + "/api/auth/session"))).authenticated, true);
  async function loginApp(id, url) {
    const origin = new URL(url).origin;
    const csrf = await json(await page.request.get(core + "/api/auth/csrf"));
    const verifier = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const { code } = await json(await page.request.post(core + "/api/apps/" + encodeURIComponent(id) + "/launch-code", {
      headers: { Origin: core, "X-Hosty-CSRF": csrf.token },
      data: { redirectUri: url, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256" },
    }));
    const result = await page.request.post(origin + "/api/auth/app-code", { headers: { Origin: origin }, data: { code, codeVerifier: verifier } });
    assert.equal(result.status(), 200);
  }
  await loginApp(config.shellId, config.shellLink);
  await loginApp(config.appId, config.link);
  console.log("PASS: Chromium signed in to Core and exchanged both Shell and Harness launch codes");
  const shell = new URL(config.shellLink).origin;
  const embeddedUrl = path => shell + "/workspace?" + new URLSearchParams({ app: config.appId, path });
  const frame = page.frameLocator('iframe[title^="Hosty Harness:"]');
  await page.goto(embeddedUrl("/settings/speech"));
  for (const role of ["Dictation", "Read aloud"]) {
    const trigger = frame.getByRole("combobox", { name: role, exact: true });
    if ((await trigger.innerText()).trim() === config.localName) continue;
    await trigger.click();
    await frame.getByRole("option", { name: config.localName, exact: true }).click();
    await frame.getByText(role + " saved.", { exact: true }).waitFor();
  }
  await page.reload();
  assert.match(await frame.getByRole("combobox", { name: "Read aloud", exact: true }).innerText(), /Fixture Voice/);
  console.log("PASS: both local speech selections persist after a Shell workspace reload");
  const headers = { Origin: config.harness };
  const createChat = async title => json(await page.request.post(config.harness + "/api/sessions",
    { headers, data: { title, connectionId: config.connection } }));
  const first = await createChat("Named speech");
  const second = await createChat("Speech selection continuity");
  const chat = id => embeddedUrl("/chats?session=" + encodeURIComponent(id));
  await page.goto(chat(second.id));
  await frame.getByRole("button", { name: "Dictate", exact: true }).waitFor();
  await page.goto(chat(first.id));
  const textbox = frame.getByRole("textbox", { name: "Message", exact: true });
  await textbox.fill("Draft:");
  const mic = frame.getByRole("button", { name: "Dictate", exact: true });
  assert.equal(await mic.count(), 1);
  await mic.click();
  await frame.getByRole("button", { name: "Stop recording" }).waitFor();
  await wait(700);
  await frame.getByRole("button", { name: "Stop recording" }).click();
  await frame.locator('textarea[aria-label="Message"]').evaluate(async el => {
    const deadline = Date.now() + 30000;
    while (!el.value.includes("Проверка диктовки") && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  });
  assert.match(await textbox.inputValue(), /^Draft:.*Проверка диктовки/);
  console.log("PASS: one chat microphone inserted the transcript after the existing draft");
  await json(await page.request.post(config.harness + "/api/sessions/" + first.id + "/messages", {
    headers, data: { text: "SPEECH_SECTION_ACCEPTANCE", clientRequestId: randomUUID() },
  }));
  const deadline = Date.now() + 45_000;
  const voice = frame.getByText("AI-generated voice", { exact: true }).first();
  while (!(await voice.isVisible()) && Date.now() < deadline) {
    const result = await json(await page.request.get(config.harness + "/api/sessions/" + first.id));
    assert.ok(!["failed", "cancelled"].includes(result.status), "Fixture agent response ended with status " + result.status);
    await wait(300);
  }
  await voice.waitFor();
  const h = frame.getByRole("heading", { name: /Алтай/ });
  const prior = await readFile(config.evidence, "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  await h.getByRole("button", { name: "Read section aloud" }).click();
  async function receipt(match) {
    const deadline = Date.now() + 20000;
    do {
      let log = "";
      try { log = await readFile(config.evidence, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (log.slice(prior.length).trim().split("\n").filter(Boolean).map(s => JSON.parse(s)).some(match)) return;
      await wait(80);
    } while (Date.now() < deadline);
    throw Error("Missing speech provider receipt");
  }
  const expected = createHash("sha256").update("Алтай\nВремя — 12:30.\nИмена\nАнна и Лев.").digest("hex");
  await receipt(row => row.textHash === expected);
  await frame.getByRole("button", { name: "Stop reading", exact: true }).click();
  await receipt(row => row.cancelled === true);
  console.log("PASS: Shell-embedded chat dictation, exact section text and upstream playback cancellation");

  // Keep the chat open and dictate into one particular feedback field. A sibling field and the
  // chat draft must retain their original values while the microphone operates in the tool frame.
  await textbox.fill("Chat retained");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const pin = page.getByRole("menuitemcheckbox", { name: "Pin Hosty Harness — Feedback to top bar", exact: true });
  if (await pin.count() && await pin.getAttribute("aria-checked") !== "true") await pin.click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Hosty Harness — Feedback", exact: true }).click();
  const panel = page.frameLocator('iframe[title="Feedback"]').getByRole("main", { name: "Feedback draft" });
  await panel.getByRole("checkbox", { name: "Include screenshot", exact: true }).uncheck();
  await panel.getByRole("button", { name: "Page comment", exact: true }).click();
  const note = panel.getByRole("textbox", { name: "Comment 1", exact: true });
  const overall = panel.getByRole("textbox", { name: "Overall comment (optional)", exact: true });
  await overall.fill("Overall retained");
  await note.fill("Annotation:");
  const group = panel.getByRole("group", { name: "Comment 1 and attachments", exact: true });
  await group.getByRole("button", { name: "Dictate", exact: true }).click();
  const stop = group.getByRole("button", { name: "Stop and transcribe", exact: true });
  await stop.waitFor();
  await wait(750);
  await stop.click();
  await note.evaluate(async el => {
    const deadline = Date.now() + 20_000;
    while (!el.value.includes("Проверка диктовки") && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  });
  assert.equal(await note.inputValue(), "Annotation: Проверка диктовки");
  assert.equal(await overall.inputValue(), "Overall retained");
  assert.equal(await textbox.inputValue(), "Chat retained");
  console.log("PASS: feedback dictation reaches only its chosen field while the chat draft stays intact");
} catch (error) {
  if (activePage) {
    const frames = await Promise.all(activePage.frames().map(async frame => ({
      path: new URL(frame.url() || "about:blank").pathname,
      headings: (await frame.locator("h1,h2").allTextContents().catch(() => [])).slice(0, 8),
    })));
    console.error("Speech browser frame diagnostics", JSON.stringify(frames));
  }
  throw error;
} finally {
  await browser.close();
}
