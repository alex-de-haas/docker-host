// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackSpeech, useFeedbackSpeech } from "./feedback-speech";
import { appFetch } from "@hosty-sdk/app/browser-auth";
vi.mock("@hosty-sdk/app/browser-auth",()=>({appFetch:vi.fn()}));
vi.mock("./feedback-audio",()=>({recordingWave:vi.fn(async()=>({arrayBuffer:async()=>new Uint8Array([1,2]).buffer}))}));
let root: Root, element: HTMLDivElement;
const text = vi.fn(), overall = vi.fn();
function Form({ disabled = false, onNote = text }: { disabled?: boolean; onNote?: (value: string) => void }) {
  const speech = useFeedbackSpeech("/feedback", disabled);
  return <><FeedbackSpeech speech={speech} target="note" disabled={disabled} onText={onNote}/><FeedbackSpeech speech={speech} target="overall" disabled={disabled} onText={overall}/></>;
}
const buttons = (name: string) => [...element.querySelectorAll("button")].filter(b => b.getAttribute("aria-label") === name);
const click = async(name:string, index=0)=>act(async()=>{buttons(name)[index].click();});
beforeEach(()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.mocked(appFetch).mockResolvedValue(Response.json({granted:true,providers:[{appId:"independent.speech",key:"local",displayName:"Local",available:true}]}));
  element=document.createElement("div");document.body.append(element);root=createRoot(element);
});
afterEach(async()=>{await act(async()=>root.unmount());element.remove();vi.useRealTimers();vi.resetAllMocks();vi.unstubAllGlobals();});
const mount=()=>act(async()=>root.render(<Form/>));
it("cancel during microphone permission stops the late stream and sends no audio",async()=>{
  let resolve!: (stream:unknown)=>void; const stop=vi.fn();
  vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:vi.fn(()=>new Promise(r=>{resolve=r;}))}}); vi.stubGlobal("MediaRecorder",class {});
  await mount();await click("Dictate");await click("Cancel dictation");
  await act(async()=>resolve({getTracks:()=>[{stop}]}));
  expect(stop).toHaveBeenCalled();expect(text).not.toHaveBeenCalled();
  expect(vi.mocked(appFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
});
it("stopping transcribes while cancellation prevents late text",async()=>{
  const stop=vi.fn();vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})}});
  vi.stubGlobal("MediaRecorder",class {state="inactive";mimeType="audio/webm";onstop?:()=>void;start(){this.state="recording";}stop(){this.state="inactive";this.onstop?.();}});
  await mount();let finish!: (value:Response)=>void;
  vi.mocked(appFetch).mockImplementation(async(_url,init)=> {expect(init?.method).toBe("POST");return new Promise(r=>{finish=r;});});
  await click("Dictate");expect(text).not.toHaveBeenCalled();await click("Stop and transcribe");expect(stop).toHaveBeenCalled();
  await click("Cancel dictation"); await act(async()=>finish(Response.json({text:"Late transcript"})));expect(text).not.toHaveBeenCalled();
});

function mockRecorder() {
  const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal("MediaRecorder", class {
    state = "inactive"; mimeType = "audio/webm"; onstop?: () => void;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  });
  return stop;
}
it("retains its separate one-minute capture limit", async () => {
  vi.useFakeTimers(); const stop = mockRecorder(); await mount();
  vi.mocked(appFetch).mockResolvedValue(Response.json({ text: "Short comment" }));
  await click("Dictate");
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(vi.mocked(appFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(vi.mocked(appFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  expect(stop).toHaveBeenCalled(); expect(text).toHaveBeenCalledWith("Short comment");
});
it("shares one roster and recorder, delivering text to the initiating field even after callbacks change", async () => {
  mockRecorder(); await mount();
  expect(appFetch).toHaveBeenCalledTimes(1);
  await click("Dictate");
  expect(buttons("Dictate")[0].disabled).toBe(true);
  const replacement = vi.fn(); await act(async () => root.render(<Form onNote={replacement}/>));
  vi.mocked(appFetch).mockResolvedValue(Response.json({ text: "A note" }));
  await click("Stop and transcribe");
  expect(text).toHaveBeenCalledWith("A note"); expect(replacement).not.toHaveBeenCalled(); expect(overall).not.toHaveBeenCalled();
  await click("Dictate", 1);
  vi.mocked(appFetch).mockResolvedValue(Response.json({ text: "Overall context" }));
  await click("Stop and transcribe");
  expect(overall).toHaveBeenCalledWith("Overall context"); expect(text).toHaveBeenCalledTimes(1);
});
it("unmount cancels transcription and stops the microphone", async () => {
  const stop = mockRecorder(); await mount();
  let finish!: (value: Response) => void;
  vi.mocked(appFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await click("Dictate"); await click("Stop and transcribe");
  await act(async () => root.render(null));
  await act(async () => finish(Response.json({ text: "No longer relevant" })));
  expect(stop).toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
});
it("disabling the draft cancels a pending microphone grant", async () => {
  let finish!: (value: unknown) => void; const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => new Promise(resolve => { finish = resolve; })) } });
  vi.stubGlobal("MediaRecorder", class {});
  await mount(); await click("Dictate"); await act(async () => root.render(<Form disabled/>));
  await act(async () => finish({ getTracks: () => [{ stop }] }));
  expect(stop).toHaveBeenCalled(); expect(buttons("Dictate").every(button => button.disabled)).toBe(true);
  expect(appFetch).toHaveBeenCalledTimes(1);
});
