import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Invoked by the managed Shell fixture. Credentials remain in memory and browser state
// is discarded at exit. Do not print Playwright errors: their call logs may include inputs.
let stage = "configuration";
let browser;
let page;
try {
  const config = JSON.parse(readFileSync(0, "utf8"));
  const { chromium } = await import(pathToFileURL(config.playwrightModule).href);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: "dark" });
  page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", () => pageErrors.push("page_error"));
  async function waitForCheck(read, timeout = 150000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await read();
      if (value) return value;
      await delay(250);
    }
    throw new Error("Browser observation deadline exceeded");
  }

  stage = "Core login page";
  await page.goto(config.coreOrigin + "/login?returnTo=%2Faccount%2Ftokens", { waitUntil: "domcontentloaded" });
  stage = "normal password submission";
  await page.getByLabel("Email", { exact: true }).fill(config.email);
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  stage = "authenticated Core session";
  await page.waitForURL(config.coreOrigin + "/account/tokens", { waitUntil: "domcontentloaded" });
  await waitForCheck(() => page.evaluate(async () => (await (await fetch("/api/auth/session", { cache: "no-store" })).json()).authenticated === true));

  stage = "Core launch and Settings navigation";
  await page.goto(config.appUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor({ timeout: 60000 });
  await page.goto(config.appOrigin + "/settings?tab=host&section=storage", { waitUntil: "domcontentloaded" });
  stage = "Storage heading";
  await page.getByRole("heading", { name: "Storage", exact: true }).waitFor({ timeout: 60000 });
  stage = "Host heading";
  await page.getByRole("heading", { name: "Host", level: 1, exact: true }).waitFor();
  stage = "selected Storage tab";
  assert.equal(await page.getByRole("tab", { name: "Storage", exact: true }).getAttribute("aria-selected"), "true");
  stage = "Hosty storage overview";
  await page.getByRole("heading", { name: "Hosty storage", exact: true }).waitFor();
  const categories = page.getByRole("list", { name: "Storage categories", exact: true });
  await categories.waitFor();
  assert.equal(await categories.getByRole("button").count(), 6);
  assert.equal(await page.locator('button[title^="Applications:"]').count(), 1);

  stage = "recount and cached measurement";
  const before = await page.evaluate(async () => (await (await fetch("/api/core/api/storage", { cache: "no-store" })).json()).snapshot.id);
  const refreshResponse = page.waitForResponse(response => response.url() === config.appOrigin + "/api/core/api/storage/refresh" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Recount", exact: true }).click();
  assert.equal((await refreshResponse).status(), 202);
  const completed = await waitForCheck(() => page.evaluate(async before => {
    const state = await (await fetch("/api/core/api/storage", { cache: "no-store" })).json();
    return state.snapshot && state.snapshot.id !== before && !state.isScanning ? state : null;
  }, before));
  await waitForCheck(() => page.locator("time").first().getAttribute("datetime").then(value => value === completed.snapshot.measuredAt));
  await page.getByRole("button", { name: "Recount", exact: true }).waitFor();

  stage = "category and resource disclosure";
  const applications = categories.getByRole("button", { name: /^Applications/ });
  await applications.click();
  assert.equal(await applications.getAttribute("aria-pressed"), "true");
  const applicationResources = page.getByRole("list", { name: "Applications resources", exact: true });
  await applicationResources.getByRole("button", { name: /^Hosty Shell/ }).click();
  await page.getByText("Path inside Hosty", { exact: true }).waitFor();
  const applicationLink = page.getByRole("link", { name: "Application storage", exact: true });
  assert.equal(await applicationLink.getAttribute("href"), "/apps/hosty.shell?section=storage");

  stage = "responsive overview";
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1100 });

  stage = "application Storage tab and overview return";
  await applicationLink.click();
  await page.getByRole("heading", { name: "Application storage", exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole("heading", { name: "Related resources", exact: true }).waitFor();
  const contents = page.getByRole("list", { name: "Application contents", exact: true });
  await contents.getByRole("button", { name: /^Cache/ }).click();
  await page.getByText(/^Logical file size:/).waitFor();
  await page.getByRole("link", { name: "Hosty storage overview", exact: true }).click();
  await page.getByRole("heading", { name: "Hosty storage", exact: true }).waitFor();
  assert.equal(new URL(page.url()).search, "?tab=host&section=storage");
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS: real Chrome password login, Core launch, Settings Host Storage, recount, category/resource disclosure, mobile layout and application Storage return");
} catch (error) {
  const route = page ? new URL(page.url()) : null;
  const safePath = route && ["/login", "/account/tokens", "/api/auth/session", "/settings", "/dashboard"].includes(route.pathname) ? route.pathname : "other";
  const safeDetail = ["Storage heading", "Host heading", "selected Storage tab", "Hosty storage overview", "recount and cached measurement", "category and resource disclosure", "responsive overview", "application Storage tab and overview return"].includes(stage) ? "; " + error.message.split("\n")[0] : "";
  console.error("Storage browser acceptance failed at " + stage + " (" + error.name + "; " + (route?.origin ?? "no-page") + safePath + safeDetail + ")");
  process.exitCode = 1;
} finally {
  await browser?.close();
}
