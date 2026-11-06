// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeechInput } from "./speech-input";
const api = vi.hoisted(() => ({ call: vi.fn(), recordingWave: vi.fn() }));
const activity = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), onFrame: null as null | ((value: { level: number; speaking: boolean; available?: boolean }) => void) }));
vi.mock("@/lib/speech-activity", () => ({ startSpeechActivity: activity.start }));
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
const render = async (key = "one", disabled = false) => {
  await act(async () => root.render(<SpeechInput key={key} disabled={disabled} onText={onText} />));
};
const click = async (name: string) => act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click());
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  activity.onFrame = null;
  activity.start.mockImplementation((_stream: MediaStream, onFrame: typeof activity.onFrame) => { activity.onFrame = onFrame; return activity.stop; });
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
  await render(); expect(document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.disabled).toBe(true);
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
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
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
  const reason = () => document.querySelector('button[aria-label="Dictate"]')!.parentElement!.getAttribute("aria-label");
  expect(reason()).toContain("Checking speech-to-text availability");
  await act(async () => reject(new Error("Core unavailable")));
  expect(reason()).toContain("Could not check speech providers: Core unavailable");
  expect(reason()).not.toContain("Allow speech-to-text");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!.disabled).toBe(false);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("explains temporary unavailability while sending", async () => {
  await render("one", true);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!;
  expect(button.disabled).toBe(true);
  expect(button.parentElement!.getAttribute("aria-label")).toContain("while a message is being sent");
});

const chooseProvider = async (label: string) => {
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Speech provider"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)!;
  expect(option).toBeDefined();
  await act(async () => option.click());
};
it("preserves explicit empty and unavailable speech choices and sends the selected identity", async () => {
  const roster = { granted: true, providers: [{ appId: "speech.one", key: "fast", displayName: "Fast speech", available: true }, { appId: "speech.two", key: "accurate", displayName: "Accurate speech", available: true }, { appId: "speech.offline", key: "default", displayName: "Offline speech", available: false }] };
  api.call.mockImplementation(async (path: string) => path === "/speech/providers" ? Response.json(roster) : new Promise<Response>(resolve => { resolveTranscript = resolve; }));
  await render();
  const dictate = () => document.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!;
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
  expect(document.querySelector('[aria-label="Speech provider"]')).toBeNull();
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
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!.disabled).toBe(true);
  expect(document.querySelector('[aria-label="Speech provider"]')?.textContent).not.toContain("Fast speech");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await chooseProvider("Fast speech");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Dictate"]')!.disabled).toBe(false);
});

it("starts dictation with one microphone click and keeps compact controls inline", async () => {
  await render();
  expect(document.querySelector('[aria-label="Dictation settings"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("Dictate");
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  const controls = container.querySelector('[role="group"][aria-label="Dictation"]')!;
  expect(controls.querySelectorAll('[data-speech-bar]')).toHaveLength(5);
  expect(controls.querySelector('button[aria-label="Stop recording"]')).not.toBeNull();
  expect(controls.querySelector('button[aria-label="Cancel dictation"]')).not.toBeNull();
  expect(controls.querySelector('[role="status"] .sr-only')?.textContent).toBe("Recording dictation");
  expect(controls.textContent).not.toContain("120 s");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("Cancel dictation");
  expect(stopTrack).toHaveBeenCalled();
  expect(api.call.mock.calls.some(([path]) => path.startsWith('/speech/transcriptions'))).toBe(false);
  expect(onText).not.toHaveBeenCalled();
});

it("shows live signal levels during recording and releases analysis before transcription", async () => {
  await render(); expect(activity.start).not.toHaveBeenCalled();
  await click("Dictate");
  expect(activity.start).toHaveBeenCalledOnce();
  const stream = await vi.mocked(navigator.mediaDevices.getUserMedia).mock.results[0]!.value;
  expect(activity.start.mock.calls[0]![0]).toBe(stream);
  const bars = () => [...container.querySelectorAll<HTMLElement>('[data-speech-bar]')];
  expect(bars().map(bar => bar.style.height)).toEqual(["2px", "2px", "2px", "2px", "2px"]);
  await act(async () => activity.onFrame?.({ level: 0.8, speaking: true }));
  expect(container.querySelector('[data-speech-meter]')?.getAttribute('data-speaking')).toBe('true');
  expect(parseFloat(bars()[2]!.style.height)).toBeGreaterThan(10);
  await act(async () => activity.onFrame?.({ level: 0, speaking: false }));
  expect(bars().every(bar => bar.style.height === "2px")).toBe(true);
  await click("Stop recording");
  expect(activity.stop).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-speech-meter]')).toBeNull();
  await act(async () => activity.onFrame?.({ level: 1, speaking: true }));
  expect(container.querySelector('[data-speech-meter]')).toBeNull();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
});
it.each(["cancel", "conversation", "send"])("stops live analysis on %s without leaking a recording", async kind => {
  await render(); await click("Dictate");
  if (kind === "cancel") await click("Cancel dictation");
  else await render(kind === "conversation" ? "two" : "one", kind === "send");
  expect(activity.stop).toHaveBeenCalledOnce(); expect(stopTrack).toHaveBeenCalled();
  expect(container.querySelector('[data-speech-meter]')).toBeNull();
  expect(api.call.mock.calls.some(([path]) => path.startsWith('/speech/transcriptions'))).toBe(false);
});

it("keeps dictation usable when signal analysis is unavailable", async () => {
  await render(); await click("Dictate");
  await act(async () => activity.onFrame?.({ level: 0, speaking: false, available: false }));
  expect(container.querySelector('[data-speech-meter-unavailable]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Stop recording"]')).not.toBeNull();
  await click("Stop recording");
  await act(async () => resolveTranscript(Response.json({ text: "Recording still works" })));
  expect(onText).toHaveBeenCalledExactlyOnceWith("Recording still works");
});
