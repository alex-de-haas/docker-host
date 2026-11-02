// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureStill, cropCaptureToDocument } from "./feedback-capture";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("denied capture leaves comments available and never hides the editor", async () => {
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) } });
  const hide = vi.fn(); await expect(captureStill(hide,new AbortController().signal)).rejects.toThrow("Denied"); expect(hide).not.toHaveBeenCalled();
});
it("a cancelled chooser stops a late-granted stream without capturing it", async () => {
  let resolve!: (stream: unknown) => void; const stop = vi.fn();
  vi.stubGlobal("navigator", {mediaDevices:{getDisplayMedia:vi.fn(()=>new Promise(r=>{resolve=r;}))}});
  const abort = new AbortController(), hide = vi.fn(); const pending = captureStill(hide,abort.signal);
  abort.abort(); resolve({getTracks:()=>[{stop}]});
  await expect(pending).rejects.toThrow(); expect(stop).toHaveBeenCalled(); expect(hide).not.toHaveBeenCalledWith(true);
});
it("a source failure stops all tracks and restores capture chrome", async () => {
  const stop = vi.fn(), hide = vi.fn();
  vi.stubGlobal("navigator", {mediaDevices:{getDisplayMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})}});
  vi.spyOn(HTMLMediaElement.prototype,"play").mockRejectedValue(new Error("Source closed"));
  await expect(captureStill(hide,new AbortController().signal)).rejects.toThrow("Source closed");
  expect(stop).toHaveBeenCalled(); expect(hide.mock.calls).toEqual([[true],[false]]);
});

it("crops only after the browser verifies the source document", async () => {
  const target = {}, cropTo = vi.fn().mockResolvedValue(undefined), fromElement = vi.fn().mockResolvedValue(target);
  vi.stubGlobal("CropTarget", {fromElement});
  expect(await cropCaptureToDocument({cropTo} as unknown as MediaStreamTrack)).toBe(true);
  expect(fromElement).toHaveBeenCalledWith(document.documentElement); expect(cropTo).toHaveBeenCalledWith(target);
  cropTo.mockRejectedValue(new Error("Not the captured tab"));
  expect(await cropCaptureToDocument({cropTo} as unknown as MediaStreamTrack)).toBe(false);
  expect(await cropCaptureToDocument()).toBe(false);
});
