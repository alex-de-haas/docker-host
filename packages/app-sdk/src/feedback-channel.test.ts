import {describe,it,expect,vi} from 'vitest';
import {FeedbackHost,feedbackScope,validDraft,type FeedbackSource,type FeedbackOperation} from './feedback-channel';
const cap={version:1 as const,coreId:'core',appId:'unrelated.vendor',installation:'install',userId:'alice',maxAnnotations:20,maxImageBytes:2097152,maxTotalImageBytes:8388608};
const source:FeedbackSource={id:'document',label:'Example',route:'/page',workspaceId:'window-a',capabilities:cap};
const draft={key:feedbackScope(cap),revision:1,requestId:'retry-1',comment:'',annotations:[],submitting:true};
describe('composer broker',()=>{
  it('refreshes retained composer sources when a compact panel becomes visible again',async()=>{
    const h=new FeedbackHost(),receive=vi.fn();let visible=true;
    h.register({...source,visible:()=>true,invoke:vi.fn()});h.connect('c',{workspaceId:'window-a',visible:()=>visible,receive});
    visible=false;h.refresh();expect(receive).toHaveBeenLastCalledWith({type:'sources',sources:[]});
    visible=true;h.refresh();expect(receive.mock.calls.at(-1)?.[0].sources).toHaveLength(1);
    const count=receive.mock.calls.length;h.refresh();expect(receive).toHaveBeenCalledTimes(count);
  });
  it('rejects unopened clients and keeps desktop workspaces isolated',async()=>{
    const h=new FeedbackHost(),invoke=vi.fn(async()=>null);h.register({...source,visible:()=>true,invoke});
    await expect(h.request('unknown',{action:'legacy-read',sourceId:source.id})).rejects.toThrow('declared');
    const other=h.connect('composer',{workspaceId:'window-b',visible:()=>true,receive:vi.fn()});
    expect(await other.request({action:'sources'})).toEqual([]);
    await expect(other.request({action:'legacy-read',sourceId:source.id})).rejects.toThrow('no longer visible');expect(invoke).not.toHaveBeenCalled();
  });
  it('attributes submission to the source, never the provider, and rejects retargeting',async()=>{
    const h=new FeedbackHost(),invoke=vi.fn(async()=>({ok:true}));h.register({...source,visible:()=>true,invoke});
    const p=h.connect('third-party-composer',{workspaceId:'window-a',visible:()=>true,receive:vi.fn()});
    await expect(p.request({action:'submit',sourceId:source.id,draft:{...draft,key:'other'}})).rejects.toThrow('different application');
    await p.request({action:'submit',sourceId:source.id,draft});expect(invoke).toHaveBeenCalledWith({action:'submit',sourceId:source.id,draft});
  });
  it('invalidates results when source or composer closes',async()=>{
    const h=new FeedbackHost();let resolve!:(v:unknown)=>void;
    h.register({...source,visible:()=>true,invoke:()=>new Promise(r=>{resolve=r;})});
    const p=h.connect('composer',{workspaceId:'window-a',visible:()=>true,receive:vi.fn()});
    const pending=p.request({action:'legacy-read',sourceId:source.id});p.close();resolve(draft);
    await expect(pending).rejects.toThrow('source document changed');
  });
  it('only the first picked source wins and all participants cancel',async()=>{
    const h=new FeedbackHost(),receive=vi.fn(),resolvers=new Map<string,(v:unknown)=>void>(),cancels:string[]=[];
    for(const id of ['one','two'])h.register({...source,id,visible:()=>true,invoke:(o:FeedbackOperation)=>o.action==='pick'?new Promise(r=>{resolvers.set(id,r);}):Promise.resolve(cancels.push(id))});
    const p=h.connect('composer',{workspaceId:'window-a',visible:()=>true,receive});await p.request({action:'pick'});
    expect([...resolvers.keys()]).toEqual(['one','two']);
    const note={id:'note',text:'',route:'/page',capturedAt:new Date().toISOString(),target:{kind:'element',label:'button'}};
    resolvers.get('two')!(note);await Promise.resolve();resolvers.get('one')!(note);await Promise.resolve();
    expect(receive.mock.calls.filter(([e])=>e.type==='selection')).toHaveLength(1);expect(receive.mock.calls.slice(-2).map(([e])=>e.type)).toEqual(['selection','picking']);expect(cancels.sort()).toEqual(['one','two']);expect(h.getSnapshot().picking).toBe(false);
  });
  it('refuses recovery data for a different account or target',async()=>{
    const h=new FeedbackHost();h.register({...source,visible:()=>true,invoke:async()=>({...draft,key:'another-scope'})});
    const p=h.connect('c',{workspaceId:'default',visible:()=>true,receive:vi.fn()});
    await expect(p.request({action:'legacy-read',sourceId:source.id})).rejects.toThrow('invalid recovery draft');
  });
  it('does not expose hidden sources or malformed evidence',async()=>{
    const h=new FeedbackHost();h.register({...source,visible:()=>false,invoke:vi.fn()});const p=h.connect('c',{workspaceId:'default',visible:()=>true,receive:vi.fn()});
    expect(await p.request({action:'sources'})).toEqual([]);
    expect(validDraft({...draft,annotations:[{id:'n',text:'',route:'/',capturedAt:'now',target:{kind:'element',bounds:{x:NaN}}}]})).toBe(false);
  });
});
