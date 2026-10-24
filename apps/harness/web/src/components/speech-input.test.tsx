// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeechInput } from "./speech-input";
const api = vi.hoisted(() => ({ call: vi.fn(), recordingWave: vi.fn() }));
vi.mock("@/lib/api", () => ({ call: api.call }));
vi.mock("@/lib/speech-audio", () => ({ recordingWave: api.recordingWave }));
let container: HTMLDivElement, root: Root;
const stopTrack = vi.fn(), onText = vi.fn();
let resolveTranscript: (value: Response) => void;
class Recorder {
  state = "inactive"; mimeType = "audio/webm";
  onstop?: () => void; ondataavailable?: (event: { data: Blob }) => void;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["recording"]) }); this.onstop?.(); }
}
const render = async (key = "one", disabled = false) => act(async () => root.render(<SpeechInput key={key} disabled={disabled} onText={onText} />));
const click = async (name: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } });
  api.call.mockImplementation(async (path: string) => path === "/speech/providers" ? Response.json({ granted: true, providers: [{ appId: "whisper", key: "default", displayName: "Whisper", available: true }] }) : new Promise<Response>(resolve => { resolveTranscript = resolve; }));
  api.recordingWave.mockResolvedValue(new Blob(["wave"]));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("inserts recognized text only after stop and releases the microphone", async () => {
  await render(); await click("Dictate"); expect(onText).not.toHaveBeenCalled();
  await click("Stop recording"); expect(stopTrack).toHaveBeenCalled();
  await act(async () => resolveTranscript(Response.json({ text: "  recognized text  " })));
  expect(onText).toHaveBeenCalledExactlyOnceWith("recognized text");
});
it.each(["cancel", "conversation", "send"])("ignores late results after %s", async kind => {
  await render(); await click("Dictate"); await click("Stop recording");
  if (kind === "cancel") await click("Cancel dictation");
  else await render(kind === "conversation" ? "two" : "one", kind === "send");
  await act(async () => resolveTranscript(Response.json({ text: "late" })));
  expect(onText).not.toHaveBeenCalled(); expect(stopTrack).toHaveBeenCalled();
});
it("does not start microphone capture without a grant", async () => {
  api.call.mockResolvedValue(Response.json({ granted: false, providers: [] }));
  await render(); expect(container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.disabled).toBe(true);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
it.each([
  [{ granted: false, reviewAvailable: true, requestable: false, providers: [] }, "Review changes and confirm in Core"],
  [{ granted: false, requestable: true, providers: [] }, "Review optional permissions"],
  [{ granted: false, requestable: false, providers: [] }, "Review an updated Harness manifest in Core"],
  [{ granted: false, providers: [] }, "Ask a host administrator to review its installation permissions"],
  [{ granted: true, providers: [] }, "No speech providers were found"],
  [{ granted: true, providers: [{ appId: "whisper", key: "default", displayName: "Whisper", available: false }] }, "Whisper is unavailable"],
  [{ granted: true, providers: [{ appId: "one", key: "default", available: true }, { appId: "two", key: "default", available: true }] }, "Choose a speech provider"],
])("explains an unavailable microphone on keyboard focus (%j)", async (roster, message) => {
  api.call.mockResolvedValue(Response.json(roster));
  await render();
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
  expect(button.disabled).toBe(true);
  const trigger = button.parentElement!;
  expect(trigger.tabIndex).toBe(0);
  await act(async () => trigger.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(message);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
it("distinguishes loading and failed discovery from missing consent, then recovers on focus", async () => {
  let reject!: (error: Error) => void;
  api.call.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render();
  const reason = () => container.querySelector('button[aria-label="Dictate"]')!.parentElement!.getAttribute("aria-label");
  expect(reason()).toContain("Checking speech-to-text availability");
  await act(async () => reject(new Error("Core unavailable")));
  expect(reason()).toContain("Could not check speech providers: Core unavailable");
  expect(reason()).not.toContain("Allow speech-to-text");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it("explains temporary unavailability while sending", async () => {
  await render("one", true);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
  expect(button.disabled).toBe(true);
  expect(button.parentElement!.getAttribute("aria-label")).toContain("while a message is being sent");
});

const chooseProvider = async (label: string) => {
  await act(async () => container.querySelector<HTMLElement>('[aria-label="Speech provider"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)!;
  expect(option).toBeDefined();
  await act(async () => option.click());
};
it("preserves explicit empty and unavailable speech choices and sends the selected identity", async () => {
  const roster = { granted: true, providers: [{ appId: "speech.one", key: "fast", displayName: "Fast speech", available: true }, { appId: "speech.two", key: "accurate", displayName: "Accurate speech", available: true }, { appId: "speech.offline", key: "default", displayName: "Offline speech", available: false }] };
  api.call.mockImplementation(async (path: string) => path === "/speech/providers" ? Response.json(roster) : new Promise<Response>(resolve => { resolveTranscript = resolve; }));
  await render();
  const dictate = () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!;
  expect(dictate().disabled).toBe(true);
  await chooseProvider("Offline speech (unavailable)");
  expect(dictate().disabled).toBe(true);
  await chooseProvider("Accurate speech");
  expect(dictate().disabled).toBe(false);
  await chooseProvider("Speech provider…");
  expect(dictate().disabled).toBe(true);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await chooseProvider("Accurate speech");
  await click("Dictate");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Speech provider"]')!.disabled).toBe(true);
  await click("Stop recording");
  expect(api.call).toHaveBeenCalledWith("/speech/transcriptions?appId=speech.two&key=accurate", expect.objectContaining({ method: "POST", body: expect.any(Blob), signal: expect.any(AbortSignal) }));
  await act(async () => resolveTranscript(Response.json({ text: "selected provider result" })));
  expect(onText).toHaveBeenCalledExactlyOnceWith("selected provider result");
});
it("keeps an unknown speech identity after discovery refresh until an explicit selection", async () => {
  let providers = [{ appId: "speech.one", key: "fast", displayName: "Fast speech", available: true }, { appId: "speech.two", key: "accurate", displayName: "Accurate speech", available: true }];
  api.call.mockImplementation(async () => Response.json({ granted: true, providers }));
  await render(); await chooseProvider("Accurate speech");
  providers = [{ appId: "speech.one", key: "fast", displayName: "Fast speech", available: true }, { appId: "speech.three", key: "new", displayName: "New speech", available: true }];
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!.disabled).toBe(true);
  expect(container.querySelector('[aria-label="Speech provider"]')?.textContent).not.toContain("Fast speech");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await chooseProvider("Fast speech");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!.disabled).toBe(false);
});
