// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {FeedbackComposer} from './index';
import type {FeedbackDraft,FeedbackEvent,FeedbackOperation} from '@hosty-sdk/app/feedback/client';
const state=vi.hoisted(()=>({receive:null as ((e:FeedbackEvent)=>void)|null,request:vi.fn(),drafts:new Map<string,FeedbackDraft>(),save:vi.fn(),events:[] as string[]}));
vi.mock('@hosty-sdk/app/feedback/client',async original=>({...await original<typeof import('@hosty-sdk/app/feedback/client')>(),connectFeedback:(receive:(e:FeedbackEvent)=>void)=>{state.receive=receive;return {request:state.request,close:()=>{}};}}));
vi.mock('./feedback-speech',()=>({FeedbackSpeech:()=>null}));
vi.mock('./draft',async original=>({...await original<typeof import('./draft')>(),readDraft:async(key:string)=>state.drafts.get(key)??null,saveDraft:(...args:unknown[])=>state.save(...args),deleteDraft:async(key:string)=>{state.drafts.delete(key);}}));
const cap={version:1 as const,coreId:'core',appId:'target-app',installation:'installation',userId:'alice',maxAnnotations:20,maxImageBytes:2097152,maxTotalImageBytes:8388608};
const source={id:'page',capabilities:cap,label:'Target application',route:'/view',workspaceId:'default'};
const key=JSON.stringify(['core','target-app','installation','alice']);
const annotation={id:'n',text:'Fix the title',route:'/view',capturedAt:new Date().toISOString(),target:{kind:'page' as const}};
const legacy:FeedbackDraft={key,revision:4,requestId:'old-retry',comment:'',annotations:[annotation],submitting:true};
let root:Root,mount:HTMLDivElement;
async function render(){await act(async()=>{root.render(<FeedbackComposer/>);});await act(async()=>state.receive?.({type:'sources',sources:[source]}));}
const button=(name:string)=>[...mount.querySelectorAll('button')].find(b=>b.textContent===name)!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);state.drafts.clear();state.events=[];state.save.mockReset().mockImplementation(async(draft:FeedbackDraft)=>{state.events.push('saved');state.drafts.set(draft.key,structuredClone(draft));});state.request.mockReset().mockImplementation(async(o:FeedbackOperation)=>{if(o.action==='legacy-read')return null;if(o.action==='submit')return {ok:true,status:200,result:{status:'submitted'}};return null;});mount=document.createElement('div');document.body.append(mount);root=createRoot(mount);});
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
