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
