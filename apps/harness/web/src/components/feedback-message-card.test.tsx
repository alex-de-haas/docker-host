// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackMessageCard } from "./feedback-message-card";
import type { FeedbackTranscriptCard } from "../../../src/feedback/presentation";

let root: Root, container: HTMLDivElement;
const report = (id: string): FeedbackTranscriptCard["reports"][number] => ({
  id, appId: `example.${id}`, appName: `Application ${id}`, version: "1.2.3", comment: `Comment ${id}`,
  annotations: [{ id: `note-${id}`, text: `Full annotation ${id}`, route: `/page/${id}`, hasImage: true }],
});
const card = (reports = [report("one")]): FeedbackTranscriptCard => ({ version: 1, dispatchId: "1a57d9da-2f42-4dbd-a651-27915983f6a9", messageSequence: 7, instruction: "Additional instruction", reports });
const originalText = "Original provider request\n\n**keep its source**\n<image evidence stays private>";
const render = async (value: FeedbackTranscriptCard | undefined = card(), loading = false) => act(async () => root.render(<FeedbackMessageCard card={value} originalText={originalText} loading={loading} />));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("keeps multiple reports compact with complete counts, bounded summaries and lazy disclosures", async () => {
  const values = [report("one"), { ...report("two"), comment: "", version: null }, report("three"), report("four")];
  values[0].comment = "Long comment ".repeat(80);
  values[0].annotations.push({ id: "second-note", text: "Another annotation", route: "/second", hasImage: false });
  await render(card(values));
  expect(container.textContent).toContain("Feedback submitted");
  expect(container.textContent).toContain("4 reports · 5 annotations · 4 screenshots");
  expect(container.querySelectorAll('[aria-label="Feedback summary"] > li')).toHaveLength(3);
  expect(container.textContent).toContain("Application one · 1.2.3"); expect(container.textContent).toContain("Application two · Version unknown");
  expect(container.textContent).toContain("Full annotation two"); expect(container.textContent).toContain("1 more report");
  expect(container.textContent).not.toContain("Application four"); expect(container.textContent).not.toContain(values[0].comment);
  const summary = container.querySelector('[aria-label="Feedback summary"] > li > p:last-child')!.textContent!;
  expect(Array.from(summary)).toHaveLength(180); expect(summary.endsWith("…")).toBe(true);
  expect(container.querySelector('[aria-label="Feedback details"]')).toBeNull(); expect(container.querySelector("pre")).toBeNull();
  expect(container.textContent).not.toContain("Full annotation one"); expect(container.textContent).not.toContain("Additional instruction");
  expect(button("Details").getAttribute("aria-expanded")).toBe("false"); expect(button("Original request").getAttribute("aria-expanded")).toBe("false");
});

it("renders all comments, annotations, routes and optional instructions as Markdown only when Details opens", async () => {
  const values = [report("one"), report("two"), report("three"), report("four")];
  values[0].comment = "Overall **explanation**";
  values[0].annotations[0].text = "Inspect `field_name` and [documentation](https://example.test/docs).";
  const value = { ...card(values), instruction: "Keep *all* observations." }, before = JSON.stringify(value);
  await render(value); expect(container.querySelector("strong, em, code, a")).toBeNull();
  await click("Details");
  const details = container.querySelector('[aria-label="Feedback details"]')!;
  expect(button("Details").getAttribute("aria-expanded")).toBe("true");
  expect(details.querySelector("strong")?.textContent).toBe("explanation"); expect(details.querySelector("em")?.textContent).toBe("all");
  expect(details.querySelector("code")?.textContent).toBe("field_name");
  const link = details.querySelector<HTMLAnchorElement>("a")!;
  expect(link.href).toBe("https://example.test/docs"); expect(link.target).toBe("_blank"); expect(link.rel).toBe("noopener noreferrer");
  expect(details.textContent).toContain("Application four"); expect(details.textContent).toContain("Full annotation four"); expect(details.textContent).toContain("Route: /page/one");
  expect(container.querySelector("pre")).toBeNull(); expect(JSON.stringify(value)).toBe(before);
  await click("Details"); expect(container.querySelector('[aria-label="Feedback details"]')).toBeNull();
  expect(container.querySelector("strong, em, code, a")).toBeNull();
});

it("keeps image evidence as counts and renders unsafe Markdown inert without any fetch", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const value = card();
  value.reports[0].annotations[0].text = '<img src="https://tracker.test/raw.png" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert)\n\n![Screenshot](https://tracker.test/screenshot.png)';
  await render(value); expect(container.textContent).toContain("1 report · 1 annotation · 1 screenshot");
  expect(container.querySelector("img, a")).toBeNull();
  await click("Details"); await click("Original request");
  expect(container.querySelector("img, script, iframe, picture, source, [onerror], [onclick]")).toBeNull();
  expect([...container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["https://tracker.test/screenshot.png"]);
  expect(container.textContent).toContain("Unsafe"); expect(container.textContent).toContain("Screenshot");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves the exact original request as a separate collapsed plain-text disclosure", async () => {
  await render(); expect(container.textContent).not.toContain(originalText);
  await click("Original request");
  const original = container.querySelector('pre[aria-label="Original feedback request"]')!;
  expect(original.textContent).toBe(originalText); expect(original.querySelector("strong, img, code")).toBeNull();
  expect(container.querySelector('[aria-label="Feedback details"]')).toBeNull();
  expect(button("Original request").getAttribute("aria-expanded")).toBe("true");
  await click("Original request"); expect(container.querySelector("pre")).toBeNull(); expect(container.textContent).not.toContain(originalText);
});

it.each([true, false])("retains a readable fallback and original request when card details are absent (loading=%s)", async loading => {
  await act(async () => root.render(<FeedbackMessageCard originalText={originalText} loading={loading} />));
  expect(container.textContent).toContain("Feedback submitted");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(loading ? "Loading feedback details…" : "Feedback details are unavailable.");
  expect(button("Details")).toBeUndefined(); expect(container.querySelector("img, pre")).toBeNull();
  await click("Original request"); expect(container.querySelector("pre")?.textContent).toBe(originalText);
});
