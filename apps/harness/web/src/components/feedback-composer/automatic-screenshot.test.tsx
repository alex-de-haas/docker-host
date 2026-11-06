// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { captureScreen, type FeedbackOperation } from '@hosty-sdk/app/feedback/client';
import { useAutomaticScreenshot } from './automatic-screenshot';
vi.mock('@hosty-sdk/app/feedback/client', async original => ({ ...await original<typeof import('@hosty-sdk/app/feedback/client')>(), captureScreen: vi.fn() }));
const cap = { version: 1 as const, coreId: 'core', appId: 'app', installation: 'install', userId: 'user', maxAnnotations: 20, maxImageBytes: 2097152, maxTotalImageBytes: 8388608 };
const source = { id: 'host', capabilities: cap, label: 'Host', route: '/', workspaceId: 'default' };
const child = { ...source, id: 'child', route: '/child', capabilities: { ...cap, appId: 'child', installation: 'child-install' } };
const note = { id: 'note', text: '', route: '/child', capturedAt: new Date().toISOString(), target: { kind: 'element' as const, bounds: { x: 1, y: 2, width: 10, height: 20 } } };
const blob = new Blob(['image'], { type: 'image/png' });
const request = vi.fn<(operation: FeedbackOperation) => Promise<unknown>>();
let hook: ReturnType<typeof useAutomaticScreenshot>, root: Root, mount: HTMLDivElement;
let granted: (() => Promise<void>) | undefined, signal: AbortSignal;
function Harness() { const value = useAutomaticScreenshot(request); useEffect(() => { hook = value; }, [value]); return null; }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); request.mockReset().mockResolvedValue(null); granted = undefined;
  vi.mocked(captureScreen).mockReset().mockImplementation((s, before) => {
    signal = s;
    return new Promise((resolve, reject) => {
      s.addEventListener('abort', () => reject(s.reason), { once: true });
      granted = async () => { try { await before?.(); resolve(blob); } catch (error) { reject(error); } };
    });
  });
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
  await act(async () => root.render(<Harness/>));
});
afterEach(async () => { await act(async () => root.unmount()); mount.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function pick(mode: 'element' | 'region' = 'element') {
  await act(async () => { void hook.start(mode, source, vi.fn()); });
  expect(captureScreen).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  await act(async () => { void granted?.(); });
  expect(request).toHaveBeenCalledWith({ action: 'pick', mode, sourceId: 'host' });
}
it.each(['element', 'region'] as const)('captures %s only after consent and selection, preserving the selected source', async mode => {
  await pick(mode);
  await act(async () => { hook.receive({ type: 'selection', source: child, note }); hook.receive({ type: 'picking', mode: null }); });
  expect(signal.aborted).toBe(false);
  expect(request).toHaveBeenCalledWith({ action: 'highlight', sourceId: 'child', target: note.target, requestId: 'note' });
  expect(request).toHaveBeenLastCalledWith({ action: 'highlight', sourceId: 'child' });
  expect(hook.result).toEqual({ source: child, note, blob }); expect(hook.phase).toBe(null);
});
it('page comments automatically capture after consent without an outline', async () => {
  const pageSelected = vi.fn(), pageNote = { ...note, target: { kind: "page" } }; request.mockResolvedValue(pageNote);
  await act(async () => { void hook.start('page', source, pageSelected); });
  await act(async () => { await granted?.(); });
  expect(pageSelected).toHaveBeenCalledWith({ source, note: pageNote }); expect(request).toHaveBeenCalledTimes(1);
  expect(hook.result?.blob).toBe(blob);
});
it('declining capture still starts comment selection', async () => {
  vi.mocked(captureScreen).mockRejectedValue(new Error('Permission denied'));
  await act(async () => { await hook.start('element', source, vi.fn()); });
  expect(request).toHaveBeenCalledWith({ action: 'pick', mode: 'element', sourceId: 'host' });
  expect(hook.notice).toContain('Permission denied'); expect(hook.result).toBe(null);
});
it.each(['cancel', 'hidden', 'account'] as const)('stops an active capture on %s', async reason => {
  await pick();
  await act(async () => {
    if (reason === 'cancel') hook.receive({ type: 'picking', mode: null });
    else hook.receive({ type: 'sources', sources: reason === 'hidden' ? [] : [{ ...source, capabilities: { ...cap, userId: 'other' } }] });
  });
  expect(signal.aborted).toBe(true); expect(hook.result).toBe(null); expect(hook.phase).toBe(null);
});
it('stops on unmount and ignores a late permission grant', async () => {
  await act(async () => { void hook.start('element', source, vi.fn()); });
  await act(async () => root.render(null));
  await act(async () => { await granted?.(); });
  expect(signal.aborted).toBe(true); expect(request).not.toHaveBeenCalled();
});
it('a cancelled chooser cannot later time out a newer selection', async () => {
  vi.useFakeTimers();
  await act(async () => { void hook.start('element', source, vi.fn()); });
  await act(async () => { hook.cancel(); await vi.advanceTimersByTimeAsync(60000); });
  await act(async () => { void hook.start('element', source, vi.fn()); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60001); });
  expect(signal.aborted).toBe(false); expect(request).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(signal.aborted).toBe(true); expect(request).toHaveBeenCalledWith({ action: 'cancel' });
});

it('defers the selected note until capture finishes so the form can annotate itself', async () => {
  let release!: () => void;
  const onSelected = vi.fn();
  request.mockImplementation(async operation => {
    if (operation.action === 'highlight' && operation.target) await new Promise<void>(resolve => { release = resolve; });
    return null;
  });
  await act(async () => { void hook.start('element', source, onSelected); });
  await act(async () => { void granted?.(); });
  await act(async () => { expect(hook.receive({ type: 'selection', source: child, note })).toBe(true); });
  expect(onSelected).not.toHaveBeenCalled();
  await act(async () => { release(); });
  expect(onSelected).toHaveBeenCalledWith({ source: child, note });
  expect(hook.result?.blob).toBe(blob);
});
