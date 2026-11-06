// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEvent } from "./transcript";
import { indexAttachments } from "@/lib/attachments";
import type { AssistantEvent } from "@/lib/assistant-api";

let root: Root, container: HTMLDivElement, originalClipboard: PropertyDescriptor | undefined;
const message = (text: string, type = "user_message"): AssistantEvent => ({ seq: 1, ts: "2026-11-05T12:00:00Z", type, text });
const render = (events: AssistantEvent[]) => act(async () => {
  const attachments = indexAttachments(events);
  root.render(<>{events.map(event => <TranscriptEvent key={event.seq} event={event} attachments={attachments}
    decision={null} answers={null} denyReason={false} onDecide={async () => {}} onAnswer={async () => {}} />)}</>);
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

it.each(["user_message", "assistant_text"])("renders %s prose as Markdown with headings, emphasis, lists, tables and links", async type => {
  await render([message("# Review changes\n\nUse **bold** and *emphasis*.\n\n- First item\n- Second item\n\n1. Run tests\n2. Review results\n\n| Before | After |\n| --- | --- |\n| Plain text | Markdown |\n\n[Documentation](https://example.test/docs)", type)]);
  expect(container.querySelector("h4")?.textContent).toBe("Review changes");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("em")?.textContent).toBe("emphasis");
  expect([...container.querySelectorAll("ul > li")].map(li => li.textContent)).toEqual(["First item", "Second item"]);
  expect([...container.querySelectorAll("ol > li")].map(li => li.textContent)).toEqual(["Run tests", "Review results"]);
  expect([...container.querySelectorAll("th")].map(th => th.textContent)).toEqual(["Before", "After"]);
  expect([...container.querySelectorAll("td")].map(td => td.textContent)).toEqual(["Plain text", "Markdown"]);
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.test/docs"]')!;
  expect(link.textContent).toBe("Documentation"); expect(link.target).toBe("_blank"); expect(link.rel).toBe("noopener noreferrer");
});

it("keeps fenced and inline code literal, copies the exact source and leaves the recorded message unchanged", async () => {
  const code = 'const value = "<script>";\n\n\tconst template = `literal *text*`;\n// [!code ++]';
  const text = 'Use `file_name.ts`:\n\n```typescript\n' + code + '\n```\n\nAfter the example.';
  const event = Object.freeze(message(text)), recorded = JSON.stringify(event);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await render([event]);
  expect(container.querySelector("p > code")?.textContent).toBe("file_name.ts");
  expect([...container.querySelectorAll('[data-slot="code-block-line-content"]')].map(line => line.textContent).join("\n")).toBe(code);
  expect(container.querySelector("script")).toBeNull();
  const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;
  expect(copy).not.toBeNull(); await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
  expect(event.text).toBe(text); expect(JSON.stringify(event)).toBe(recorded);
});

it("preserves visible single and hard line breaks while keeping blank lines as paragraph boundaries", async () => {
  await render([message("First line\nSecond line  \nThird line\n\nNext paragraph")]);
  const paragraphs = container.querySelectorAll("p");
  expect(paragraphs).toHaveLength(2); expect(paragraphs[0].querySelectorAll("br")).toHaveLength(2);
  expect(paragraphs[0].textContent).toMatch(/First line\s*Second line\s*Third line/);
  expect(paragraphs[1].textContent).toBe("Next paragraph");
  expect(container.querySelector('[class~="bg-primary/10"]')?.classList.contains("whitespace-pre-wrap")).toBe(false);
});

it("keeps unsafe HTML and script URLs inert and turns remote Markdown images into links without fetching them", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await render([message('<script>alert("unsafe")</script>\n\n<img src="https://tracker.test/raw.png" onerror="alert(1)">\n\n[Unsafe link](javascript:alert)\n\n[Unsafe data](data:text/html,unsafe)\n\n![Remote screenshot](https://tracker.test/screenshot.png)\n\n![Unsafe image](javascript:alert)')]);
  expect(container.querySelector("script, img, iframe, style, source, picture")).toBeNull();
  expect(container.querySelector("[onerror], [onclick]")).toBeNull();
  expect([...container.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual(["https://tracker.test/screenshot.png"]);
  expect(container.querySelector("a")?.textContent).toBe("Remote screenshot");
  expect(container.textContent).toContain('alert("unsafe")'); expect(container.textContent).toContain("Unsafe link");
  expect(container.textContent).toContain("Unsafe data"); expect(container.textContent).toContain("Unsafe image");
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["", " \n\t ", "Review **this** with `notes.md`."])("retains claimed attachment metadata alongside message text %j", async text => {
  const events = [
    { seq: 1, ts: "", type: "attachment_added", name: "stored-report.txt", size: 1024 },
    { seq: 2, ts: "", type: "user_message", text, attachments: ["stored-report.txt", "missing-size.png"] },
  ];
  const recorded = JSON.stringify(events); await render(events);
  const rows = container.querySelectorAll('[aria-label="Message attachments"]');
  expect(rows).toHaveLength(1); expect(rows[0].querySelectorAll('[data-slot="attachment"]')).toHaveLength(2);
  expect(rows[0].textContent).toContain("stored-report.txt"); expect(rows[0].textContent).toContain("1.0 KB");
  expect(rows[0].textContent).toContain("missing-size.png"); expect(rows[0].textContent).not.toContain("null");
  expect(container.querySelector("img, button")).toBeNull();
  if (text.trim()) {
    expect(container.querySelector("strong")?.textContent).toBe("this");
    expect(container.querySelector("p > code")?.textContent).toBe("notes.md");
  } else expect(container.querySelector('[class~="bg-primary/10"]')).toBeNull();
  expect(JSON.stringify(events)).toBe(recorded);
});
