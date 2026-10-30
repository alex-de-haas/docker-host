// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackSpeech } from "./feedback-speech";
import { appFetch } from "./browser-auth";
vi.mock("./browser-auth",()=>({appFetch:vi.fn()}));
vi.mock("./feedback-audio",()=>({recordingWave:vi.fn(async()=>({arrayBuffer:async()=>new Uint8Array([1,2]).buffer}))}));
let root: Root, element: HTMLDivElement;
const text = vi.fn(), busy = vi.fn();
const click = async(name:string)=>act(async()=>{[...element.querySelectorAll("button")].find(b=>b.textContent===name)!.click();});
beforeEach(()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.mocked(appFetch).mockResolvedValue(Response.json({granted:true,providers:[{appId:"independent.speech",key:"local",displayName:"Local",available:true}]}));
  element=document.createElement("div");document.body.append(element);root=createRoot(element);
});
afterEach(async()=>{await act(async()=>root.unmount());element.remove();vi.resetAllMocks();vi.unstubAllGlobals();});
const mount=()=>act(async()=>root.render(<FeedbackSpeech path="/feedback" disabled={false} onText={text} onBusyChange={busy}/>));
it("cancel during microphone permission stops the late stream and sends no audio",async()=>{
  let resolve!: (stream:unknown)=>void; const stop=vi.fn();
  vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:vi.fn(()=>new Promise(r=>{resolve=r;}))}}); vi.stubGlobal("MediaRecorder",class {});
  await mount();await click("Dictate");await click("Cancel dictation");
  await act(async()=>resolve({getTracks:()=>[{stop}]}));
  expect(stop).toHaveBeenCalled();expect(text).not.toHaveBeenCalled();
  expect(vi.mocked(appFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
});
it("only an explicitly stopped recording transcribes; unmount prevents late text",async()=>{
  const stop=vi.fn();vi.stubGlobal("navigator",{mediaDevices:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop}]})}});
  vi.stubGlobal("MediaRecorder",class {state="inactive";mimeType="audio/webm";onstop?:()=>void;start(){this.state="recording";}stop(){this.state="inactive";this.onstop?.();}});
  await mount();let finish!: (value:Response)=>void;
  vi.mocked(appFetch).mockImplementation(async(_url,init)=> {expect(init?.method).toBe("POST");return new Promise(r=>{finish=r;});});
  await click("Dictate");expect(text).not.toHaveBeenCalled();await click("Stop and transcribe");expect(stop).toHaveBeenCalled();
  await click("Cancel dictation"); await act(async()=>finish(Response.json({text:"Late transcript"})));expect(text).not.toHaveBeenCalled();
});
