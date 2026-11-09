import { afterEach, expect, it, vi } from 'vitest';
import { observeSources } from './source-events';
const { request } = vi.hoisted(()=>({request:vi.fn()}));
vi.mock('@hosty-sdk/app/browser-auth',()=>({appFetch:request}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});
function page() {
  const page=Object.assign(new EventTarget(),{visibilityState:'visible'});
  vi.stubGlobal('document',page); return page;
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
it('coalesced transport chunks preserve every change and reconnect resynchronizes',async()=>{
  vi.useFakeTimers();page();let output!:ReadableStreamDefaultController<Uint8Array>;
  request.mockImplementation(async()=>new Response(new ReadableStream({start(controller){output=controller;}})));
  const changed=vi.fn(), health=vi.fn(), stop=observeSources('repository',changed,health);
  await flush();output.enqueue(new TextEncoder().encode('event: stream.ready\ndata: {}\n\nevent: source.'));await flush();
  expect(changed).toHaveBeenCalledTimes(1);
  output.enqueue(new TextEncoder().encode('changed\ndata: {}\n\n'));await flush();expect(changed).toHaveBeenCalledTimes(2);
  output.close();await flush();await vi.advanceTimersByTimeAsync(1000);expect(request).toHaveBeenCalledTimes(2);
  output.enqueue(new TextEncoder().encode('event: stream.ready\ndata: {}\n\n'));await flush();expect(changed).toHaveBeenCalledTimes(3);
  stop();output.close();await flush();
});
it('hiding aborts the subscription and returning rereads without an idle polling loop',async()=>{
  vi.useFakeTimers();const doc=page();request.mockImplementation((_url:string,{signal}:{signal:AbortSignal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
  const changed=vi.fn(),stop=observeSources(null,changed,vi.fn());await flush();expect(request).toHaveBeenCalledTimes(1);
  const signal=request.mock.calls[0][1].signal;doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));await flush();expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);expect(request).toHaveBeenCalledTimes(1);
  doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));await flush();expect(changed).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledTimes(2);stop();await flush();
});
it('older Core reports manual freshness and does not repeatedly request an unsupported stream',async()=>{
  vi.useFakeTimers();page();request.mockResolvedValue(new Response(null,{status:501}));const health=vi.fn();const stop=observeSources(null,vi.fn(),health);await flush();
  await vi.advanceTimersByTimeAsync(120000);expect(request).toHaveBeenCalledOnce();expect(health).toHaveBeenCalledWith(expect.stringContaining('Refresh manually'));stop();
});

it('source hints retain their repository scope and malformed hints resynchronize',async()=>{
  page();let output!:ReadableStreamDefaultController<Uint8Array>;
  request.mockImplementation(async()=>new Response(new ReadableStream({start(controller){output=controller;}})));
  const changed=vi.fn(),stop=observeSources(null,changed,vi.fn());await flush();
  const id='a'.repeat(64);
  output.enqueue(new TextEncoder().encode(`event: source.changed\ndata: {"repositories":["${id}","${id}"]}\n\n`));await flush();
  expect(changed).toHaveBeenLastCalledWith([id]);
  output.enqueue(new TextEncoder().encode('event: source.changed\ndata: {"repositories":[42]}\n\n'));await flush();
  expect(changed).toHaveBeenLastCalledWith(undefined);
  stop();output.close();await flush();
});
