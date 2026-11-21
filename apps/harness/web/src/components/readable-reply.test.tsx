// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadableReply } from "./readable-reply";
import { call } from "@/lib/api";

vi.mock("@/lib/api", () => ({ call: vi.fn() }));
let root: Root, container: HTMLElement;
const cancel = vi.fn<() => void>(), close = vi.fn<() => Promise<void>>();
const markdown = "# Отчёт\n\nНе отправлять вместе с разделом.\n\n## Счёт\n\nАнна: **42**.\n\n### Детали\n\nИлья.\n\n## Конец\n\nСоседний раздел.";
const selected = { appId: "reader", installationId: "one", key: "api", implementationId: "work", displayName: "Reading · Work", available: true };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  close.mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext", class { resume = async () => {}; close = close; currentTime = 0; });
  vi.mocked(call).mockImplementation(async path => {
    if (path.includes("/providers")) return Response.json({ selected, providers: [selected], binding: "exact" });
    if (path.includes("/capabilities")) return Response.json({ maxCharacters: 4000 });
    return new Response(new ReadableStream({ cancel }), { headers: { "content-type": "audio/pcm;rate=24000" } });
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = (sessionId: string) => act(async () => root.render(<ReadableReply sessionId={sessionId} text={markdown} ts="2026-11-17T11:25:01Z" />));
it.each(["stop", "close chat"])("reads just the nested section and aborts the upstream stream on %s", async action => {
  await render("chat");
  expect(container.textContent).not.toContain("AI-generated voice");
  expect(container.querySelector('[title*="AI-generated voice"]')).toBeNull();
  expect(call).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-speech-level="2"] button')!.click());
  const invocation = vi.mocked(call).mock.calls.find(([path]) => path.startsWith("/speech/synthesis"));
  expect(invocation?.[0]).toBe("/speech/synthesis?binding=exact");
  expect(JSON.parse(invocation![1]!.body as string)).toEqual({ text: "Счёт\nАнна: 42.\nДетали\nИлья.", sessionId: "chat" });
  const stop = container.querySelector<HTMLButtonElement>('[data-slot="message-footer"] button[aria-label="Stop reading"]')!;
  if (action === "stop") await act(async () => stop.click());
  else await render("another-chat");
  expect(invocation![1]!.signal!.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("requires an explicit read-aloud provider before sending text", async () => {
  vi.mocked(call).mockResolvedValue(Response.json({ providers: [selected], selected: null, binding: null }));
  await render("chat");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="message-footer"] button[aria-label="Read aloud"]')!.click());
  expect(call).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[href="/settings/speech"]')).toBeTruthy(); expect(close).toHaveBeenCalledOnce();
});
