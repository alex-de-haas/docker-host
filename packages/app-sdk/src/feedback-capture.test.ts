// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureScreen, captureStill, cropCaptureToDocument } from "./feedback-capture";
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

it.each([false, true])("crops without a crop-status observer (custom crop: %s)", async custom => {
  const stop = vi.fn(), cropTo = vi.fn().mockResolvedValue(undefined), crop = vi.fn().mockResolvedValue(true);
  const track = { stop, cropTo };
  vi.stubGlobal("CropTarget", { fromElement: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }) } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("Source closed"));
  await expect(captureStill(vi.fn(), new AbortController().signal, undefined, custom ? crop : undefined)).rejects.toThrow("Source closed");
  expect(custom ? crop : cropTo).toHaveBeenCalledTimes(1);
  if (custom) expect(crop).toHaveBeenCalledWith(track);
  expect(stop).toHaveBeenCalled();
});

it("requests a whole surface from the gesture and waits for selection before reading a frame", async () => {
  const stop = vi.fn(), cropTo = vi.fn(), prepare = vi.fn(async () => {});
  const getDisplayMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }], getVideoTracks: () => [{ cropTo }] });
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal("CropTarget", { fromElement: vi.fn() });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
    expect(prepare).toHaveBeenCalledOnce(); throw new Error("Frame unavailable");
  });
  const pending = captureScreen(new AbortController().signal, prepare);
  expect(getDisplayMedia).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled();
  await expect(pending).rejects.toThrow("Frame unavailable");
  expect(play).toHaveBeenCalledOnce(); expect(cropTo).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalled();
});
it.each(["cancel", "source ended"])("stops capture while waiting for selection: %s", async reason => {
  const track = new EventTarget() as EventTarget & { stop: ReturnType<typeof vi.fn> };
  track.stop = vi.fn(); const controller = new AbortController();
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) } });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play");
  const prepared = vi.fn(() => new Promise<void>(() => {}));
  const pending = captureScreen(controller.signal, prepared);
  await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce());
  if (reason === "cancel") controller.abort(); else track.dispatchEvent(new Event("ended"));
  await expect(pending).rejects.toThrow();
  expect(track.stop).toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
});
