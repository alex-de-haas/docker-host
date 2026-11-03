// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {FeedbackComposer} from './index';
import type {FeedbackDraft,FeedbackEvent,FeedbackOperation} from '@hosty-sdk/app/feedback/client';
const state=vi.hoisted(()=>({receive:null as ((e:FeedbackEvent)=>void)|null,request:vi.fn(),capture:vi.fn(),drafts:new Map<string,FeedbackDraft>(),save:vi.fn(),events:[] as string[]}));
vi.mock('@hosty-sdk/app/feedback/client',async original=>({...await original<typeof import('@hosty-sdk/app/feedback/client')>(),captureScreen:(...args:unknown[])=>state.capture(...args),connectFeedback:(receive:(e:FeedbackEvent)=>void)=>{state.receive=receive;return {request:state.request,close:()=>{}};}}));
vi.mock('@hosty-sdk/app/browser-auth',()=>({appFetch:vi.fn(async()=>Response.json({granted:true,providers:[]}))}));
vi.mock('./draft',async original=>({...await original<typeof import('./draft')>(),readDraft:async(key:string)=>state.drafts.get(key)??null,saveDraft:(...args:unknown[])=>state.save(...args),deleteDraft:async(key:string)=>{state.drafts.delete(key);}}));
const cap={version:1 as const,coreId:'core',appId:'target-app',installation:'installation',userId:'alice',maxAnnotations:20,maxImageBytes:2097152,maxTotalImageBytes:8388608};
const source={id:'page',capabilities:cap,label:'Target application',route:'/view',workspaceId:'default'};
const key=JSON.stringify(['core','target-app','installation','alice']);
const annotation={id:'n',text:'Fix the title',route:'/view',capturedAt:new Date().toISOString(),target:{kind:'page' as const}};
const legacy:FeedbackDraft={key,revision:4,requestId:'old-retry',comment:'',annotations:[annotation],submitting:true};
let root:Root,mount:HTMLDivElement;
async function render(){await act(async()=>{root.render(<FeedbackComposer/>);});await act(async()=>state.receive?.({type:'sources',sources:[source]}));}
const button=(name:string)=>[...mount.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label') ?? b.textContent)===name)!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:vi.fn(()=> 'blob:screenshot'),revokeObjectURL:vi.fn()}));state.drafts.clear();state.events=[];state.capture.mockReset();state.save.mockReset().mockImplementation(async(draft:FeedbackDraft)=>{state.events.push('saved');state.drafts.set(draft.key,structuredClone(draft));});state.request.mockReset().mockImplementation(async(o:FeedbackOperation)=>{if(o.action==='legacy-read')return null;if(o.action==='submit')return {ok:true,status:200,result:{status:'submitted'}};return null;});mount=document.createElement('div');document.body.append(mount);root=createRoot(mount);});
afterEach(async()=>{await act(async()=>root.unmount());mount.remove();vi.unstubAllGlobals();});
it('imports an old source draft before acknowledging its removal and preserves retry identity',async()=>{
  state.request.mockImplementation(async(o:FeedbackOperation)=>{if(o.action==='legacy-read')return legacy;if(o.action==='legacy-delete'){expect(state.drafts.get(key)).toEqual(legacy);state.events.push('ack');}return null;});
  await render();expect(state.events).toEqual(['saved','ack']);expect(button('Retry submission')).toBeDefined();expect(mount.querySelector('textarea')?.value).toBe('Fix the title');
});
it('retains a frozen retry across reload and submits to the target application',async()=>{
  state.drafts.set(key,legacy);state.request.mockImplementation(async(o:FeedbackOperation)=>{if(o.action==='submit')throw new Error('Connection lost');return null;});await render();
  await act(async()=>button('Retry submission').click());expect(mount.textContent).toContain('Connection lost');expect(state.drafts.get(key)?.requestId).toBe('old-retry');
  await act(async()=>root.unmount());root=createRoot(mount);state.request.mockImplementation(async(o:FeedbackOperation)=>o.action==='submit'?{ok:true,status:200,result:{status:'submitted'}}:null);await render();await act(async()=>button('Retry submission').click());
  expect(state.request).toHaveBeenLastCalledWith({action:'submit',sourceId:'page',draft:legacy});expect(state.drafts.has(key)).toBe(false);expect(mount.textContent).toContain('Feedback submitted.');
});
it('does not delete source recovery data when the provider cannot save it',async()=>{
  state.request.mockResolvedValue(legacy);state.save.mockRejectedValue(new Error('Storage full'));await render();
  expect(mount.textContent).toContain('Storage full');expect(state.request.mock.calls.some(([o])=>o.action==='legacy-delete')).toBe(false);
});
it('keeps a different provider draft and leaves conflicting source evidence recoverable',async()=>{
  const current={...legacy,requestId:'newer',submitting:false};state.drafts.set(key,current);state.request.mockResolvedValue(legacy);await render();
  expect(mount.textContent).toContain('previous draft is still saved');expect(state.drafts.get(key)).toEqual(current);expect(state.request.mock.calls.some(([o])=>o.action==='legacy-delete')).toBe(false);
});
it('stores a selected note in the source app draft and keeps the form visible',async()=>{
  await render();await act(async()=>state.receive?.({type:'selection',source,note:annotation}));
  expect(state.drafts.get(key)?.annotations).toEqual([annotation]);expect(mount.querySelector('[aria-label="Feedback draft"]')).not.toBeNull();expect(button('Done')).toBeDefined();
});

const saved=()=>state.save.mock.calls.at(-1)?.[0] as FeedbackDraft;
function automaticCapture(image:Blob){
  state.capture.mockImplementation(async(_signal:AbortSignal,before:()=>Promise<void>)=>{await before();return image;});
  state.request.mockImplementation(async(o:FeedbackOperation)=>o.action==='page'?annotation:null);
}
it('automatically persists the full capture, allows removal and submits without another approval',async()=>{
  const image=new Blob(['all captured pixels'],{type:'image/png'});automaticCapture(image);
  await render();expect((mount.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  await act(async()=>button('Page comment').click());
  expect(state.capture).toHaveBeenCalledOnce();expect(mount.querySelector('[role="dialog"]')).toBeNull();
  expect(saved().annotations[0].image).toBe(image);expect(button('Retake screenshot').closest('[data-slot="input-group"]')).not.toBeNull();expect(mount.querySelector('[data-slot="attachment"]')).not.toBeNull();expect(button('Submit feedback').disabled).toBe(false);
  expect(mount.querySelector('img[alt="Preview of screenshot.png"]')).not.toBeNull();
  await act(async()=>button('Remove screenshot.png').click());
  expect(saved().annotations[0].image).toBeUndefined();expect(saved().annotations[0].text).toBe(annotation.text);
  expect(mount.querySelector('img[alt="Preview of screenshot.png"]')).toBeNull();expect(button('Add screenshot')).toBeDefined();
  state.request.mockResolvedValue({ok:true,status:200,result:{status:'submitted'}});
  await act(async()=>button('Submit feedback').click());
  expect(mount.textContent).toContain('Feedback submitted.');
});
it('adds and replaces a screenshot directly while preserving the previous image if a retake fails',async()=>{
  state.drafts.set(key,{...legacy,submitting:false});await render();
  const first=new Blob(['first frame'],{type:'image/png'}),second=new Blob(['second frame'],{type:'image/png'});
  state.capture.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValueOnce(new Error('Permission denied'));
  await act(async()=>button('Add screenshot').click());expect(saved().annotations[0].image).toBe(first);
  await act(async()=>button('Retake screenshot').click());expect(saved().annotations[0].image).toBe(second);
  await act(async()=>button('Retake screenshot').click());expect(saved().annotations[0].image).toBe(second);
  expect(mount.textContent).toContain('Permission denied');expect(mount.querySelector('[role="dialog"]')).toBeNull();
});
it('keeps the comment and explains an oversized automatic screenshot after saving completes',async()=>{
  automaticCapture(new Blob([new Uint8Array(cap.maxImageBytes+1)],{type:'image/png'}));await render();
  await act(async()=>button('Page comment').click());
  expect(saved().annotations).toEqual([annotation]);expect(mount.textContent).toContain('each image must fit within 2 MiB');
  expect(button('Submit feedback').disabled).toBe(false);expect(button('Page comment').disabled).toBe(false);
});
it('enforces the report image budget without replacing existing images',async()=>{
  const image=new Blob([new Uint8Array(cap.maxImageBytes)],{type:'image/png'});
  state.drafts.set(key,{...legacy,submitting:false,annotations:Array.from({length:4},(_,i)=>({...annotation,id:'existing-'+i,image}))});
  automaticCapture(new Blob(['another image'],{type:'image/png'}));await render();
  await act(async()=>button('Page comment').click());
  expect(saved().annotations).toHaveLength(5);expect(saved().annotations.at(-1)?.image).toBeUndefined();
  expect(mount.textContent).toContain('images may total at most 8 MiB');expect(button('Page comment').disabled).toBe(false);
});
it('consumes a capture for a rejected annotation without locking the composer',async()=>{
  state.drafts.set(key,{...legacy,submitting:false,annotations:Array.from({length:20},(_,i)=>({...annotation,id:'existing-'+i}))});
  automaticCapture(new Blob(['image'],{type:'image/png'}));await render();await act(async()=>button('Page comment').click());
  expect(state.save).not.toHaveBeenCalled();expect(mount.textContent).toContain('already contains 20 annotations');
  expect(button('Page comment').disabled).toBe(false);expect(button('Submit feedback').disabled).toBe(false);
});
it('ignores a manual capture that resolves after the account changes',async()=>{
  state.drafts.set(key,{...legacy,submitting:false});await render();let resolve!:(blob:Blob)=>void;
  state.capture.mockImplementation(()=>new Promise<Blob>(done=>{resolve=done;}));
  await act(async()=>button('Add screenshot').click());
  await act(async()=>state.receive?.({type:'sources',sources:[{...source,capabilities:{...cap,userId:'bob'}}]}));
  await act(async()=>resolve(new Blob(['late image'],{type:'image/png'})));
  expect(state.save).not.toHaveBeenCalled();expect(mount.querySelector('img[alt="Preview of screenshot.png"]')).toBeNull();
});

it('keeps both comment fields editable with independent inline microphone controls',async()=>{
  state.drafts.set(key,{...legacy,submitting:false});await render();
  const groups=[...mount.querySelectorAll('[data-slot="input-group"]')];
  expect(groups).toHaveLength(2);
  expect(groups.every(group=>group.querySelector('button[aria-label="Dictate"]'))).toBe(true);
  expect(groups[1].querySelector('button[aria-label="Add screenshot"]')).toBeNull();
  const overall=groups[1].querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(overall,'Overall explanation');overall.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(saved().comment).toBe('Overall explanation');expect(saved().annotations[0].text).toBe(annotation.text);
});

it.each(['element', 'region'] as const)('prepares and clears the saved %s outline when retaking a screenshot', async kind => {
  const image = new Blob(['old'], { type: 'image/png' }), next = new Blob(['outlined'], { type: 'image/png' });
  const target = { kind, bounds: { x: 5, y: 10, width: 100, height: 50 } };
  state.drafts.set(key, { ...legacy, submitting: false, annotations: [{ ...annotation, target, image }] });
  await render();
  state.capture.mockImplementation(async (_signal: AbortSignal, before: () => Promise<void>) => {
    await before(); expect(state.request).toHaveBeenLastCalledWith({ action: 'highlight', sourceId: source.id, target, requestId: annotation.id }); return next;
  });
  await act(async () => button('Retake screenshot').click());
  expect(saved().annotations[0].image).toBe(next);
  expect(state.request).toHaveBeenLastCalledWith({ action: 'highlight', sourceId: source.id });
  state.request.mockImplementation(async (op: FeedbackOperation) => { if (op.target) throw new Error('Select it again'); return null; });
  await act(async () => button('Retake screenshot').click());
  expect(saved().annotations[0].image).toBe(next); expect(mount.textContent).toContain('Select it again');
  expect(state.request).toHaveBeenLastCalledWith({ action: 'highlight', sourceId: source.id });
});
