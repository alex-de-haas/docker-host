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
  await context.grantPermissions(["microphone", "clipboard-write"], { origin: config.harness });
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
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: shell });
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
  const heading = frame.getByRole("heading", { name: /Алтай/ });
  while (!(await heading.isVisible()) && Date.now() < deadline) {
    const result = await json(await page.request.get(config.harness + "/api/sessions/" + first.id));
    assert.ok(!["failed", "cancelled"].includes(result.status), "Fixture agent response ended with status " + result.status);
    await wait(300);
  }
  await heading.waitFor();
  const footer = frame.locator('[data-slot="message-footer"]:has(button[aria-label="Read aloud"], button[aria-label="Stop reading"])');
  async function expectFooterVisibility(visible) {
    const matches = await footer.evaluate(async (el, visible) => {
      const deadline = performance.now() + 3000;
      do {
        if (el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) === visible) return true;
        await new Promise(resolve => requestAnimationFrame(resolve));
      } while (performance.now() < deadline);
      return false;
    }, visible);
    assert.ok(matches, "Expected the reply footer to be " + (visible ? "visible" : "hidden"));
  }
  await textbox.focus();
  await textbox.hover();
  await expectFooterVisibility(false);
  await heading.hover();
  await expectFooterVisibility(true);
  assert.ok((await footer.locator("time").innerText()).trim());
  const copy = footer.getByRole("button", { name: "Copy message", exact: true });
  await copy.focus();
  await textbox.hover();
  await expectFooterVisibility(true);
  await textbox.focus();
  await expectFooterVisibility(false);
  await heading.hover();
  const prior = await readFile(config.evidence, "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  await heading.getByRole("button", { name: "Read section aloud" }).click();
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
  await textbox.focus();
  await textbox.hover();
  await expectFooterVisibility(true);
  await footer.getByRole("button", { name: "Stop reading", exact: true }).click();
  await receipt(row => row.cancelled === true);
  await heading.hover();
  await copy.click();
  const status = footer.getByRole("status");
  await status.filter({ hasText: /Message copied|Could not copy message/ }).waitFor({ state: "attached" });
  assert.equal(await status.textContent(), "Message copied", await footer.evaluate(() => JSON.stringify({
    secureContext: isSecureContext, focused: document.hasFocus(), clipboard: Boolean(navigator.clipboard),
    clipboardWriteAllowed: document.featurePolicy?.allowsFeature("clipboard-write"),
  })));
  const markdown = ["## Алтай", "Время — 12:30.", "### Имена", "Анна и Лев.", "## Байкал", "Другой раздел."].join("\n\n");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), markdown);
  console.log("PASS: Shell-embedded message hover, focus, copy, section playback and cancellation");

  const touchContext = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 1024, height: 768 },
    hasTouch: true, isMobile: true });
  try {
    const touchPage = await touchContext.newPage();
    await touchPage.goto(chat(first.id));
    const touchFrame = touchPage.frameLocator('iframe[title^="Hosty Harness:"]');
    await touchFrame.getByRole("heading", { name: /Алтай/ }).waitFor();
    const touchFooter = touchFrame.locator('[data-slot="message-footer"]:has(button[aria-label="Read aloud"])');
    const visibleAtRest = await touchFooter.evaluate(el => window.matchMedia("(hover: none)").matches
      && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    assert.ok(visibleAtRest, "Touch users can see the message actions without hovering");
    await touchFooter.getByRole("button", { name: /Message time:/ }).tap();
    await touchFrame.locator('[data-slot="popover-content"] time').waitFor();
    console.log("PASS: touch message actions and timestamp details");
  } finally {
    await touchContext.close();
  }

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
