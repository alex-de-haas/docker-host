"use client";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { APP_SESSION_RESTORED, appFetch } from './browser-auth';
import { FEEDBACK_ROOT, feedbackScope, validCapabilities, validDraft, type DraftNote, type FeedbackOperation } from './feedback-channel';
import { readDraft, deleteDraft, submission } from './feedback-draft';
import type { FeedbackCapabilities, FeedbackRect, FeedbackTarget } from './feedback-types';
import type { UiHost } from './ui-host';
import type { EmbeddedUiClient } from './ui-embedded';
const rect = (b: DOMRect): FeedbackRect => ({ x: b.x, y: b.y, width: b.width, height: b.height });
const viewport = () => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio });
function note(target: FeedbackTarget): DraftNote { return { id: crypto.randomUUID(), text: '', route: location.pathname + location.search, capturedAt: new Date().toISOString(), target }; }
/** Selection and source-authenticated intake only. The tool application owns all form UI/storage. */
export function FeedbackCapture({ active, uiPath = '/api/hosty/ui', client }: {
    active: boolean;
    uiPath?: string;
    client?: UiHost | EmbeddedUiClient | null;
}) {
    const [capabilities, setCapabilities] = useState<FeedbackCapabilities | null>(null), [retry, setRetry] = useState(0);
    const pickMode = useRef<'element' | 'region' | null>(null), priorCursor = useRef<string | null>(null), resetPick = useRef(() => {});
    const pinned = useRef(false), highlightExpiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const outlineFrame = useRef<number | undefined>(undefined);
    const selections = useRef(new Map<string, { element?: Element; route: string }>());
    const remember = (chosen: DraftNote, element?: Element) => {
        selections.current.set(chosen.id, { element, route: location.href });
        if (selections.current.size > 20) selections.current.delete(selections.current.keys().next().value!);
        return chosen;
    };
    const clearPinned = () => { pinned.current = false; clearTimeout(highlightExpiry.current); if (outlineFrame.current !== undefined) cancelAnimationFrame(outlineFrame.current); };
    const [highlight, setHighlight] = useState<FeedbackRect | null>(null);
    const pending = useRef<((value: DraftNote | null) => void) | null>(null);
    const path = uiPath.replace(/\/$/, '') + '/feedback';
    const finish = (value: DraftNote | null) => { clearPinned(); const done = pending.current; pending.current = null; pickMode.current = null; resetPick.current(); if(priorCursor.current !== null)document.documentElement.style.cursor=priorCursor.current;priorCursor.current=null;setHighlight(null); done?.(value); };
    useEffect(() => { const refresh = () => setRetry(r => r + 1); window.addEventListener(APP_SESSION_RESTORED, refresh); return () => window.removeEventListener(APP_SESSION_RESTORED, refresh); }, []);
    useEffect(() => {
        setCapabilities(null);
        if (!active)
            return;
        const controller = new AbortController();
        void appFetch(path, { signal: controller.signal }).then(async (r) => { if (r.ok) {
            const c: unknown = await r.json();
            if (validCapabilities(c) && !controller.signal.aborted)
                setCapabilities(c);
        } }).catch(() => { });
        return () => controller.abort();
    }, [active, path, retry]);
    useEffect(() => {
        if (!active || !capabilities || !client)
            return;
        let live = true;
        const invoke = async (o: FeedbackOperation): Promise<unknown> => {
            if (!live)
                throw new Error('The source document is no longer active.');
            const key = feedbackScope(capabilities), route = location.href;
            switch (o.action) {
                case 'pick':
                    finish(null);
                    pickMode.current = o.mode ?? 'element'; priorCursor.current=document.documentElement.style.cursor;document.documentElement.style.cursor='crosshair';
                    return new Promise<DraftNote | null>(resolve => { pending.current = resolve; });
                case 'cancel':
                    finish(null);
                    return null;
                case 'page': return note({ kind: 'page', label: 'Page comment', viewport: viewport() });
                case 'highlight': {
                    clearPinned();
                    const selected = o.requestId ? selections.current.get(o.requestId) : undefined;
                    if (o.target?.bounds && o.requestId && (!selected || selected.route !== location.href || selected.element?.isConnected === false))
                        throw new Error('The selected element is no longer visible. Select it again to capture a screenshot.');
                    pinned.current = !!o.target?.bounds;
                    setHighlight(o.target?.bounds ?? null);
                    if (pinned.current) {
                        // Follow layout changes until the frame is captured instead of outlining
                        // the selected element's former position.
                        const follow = () => {
                            if (!pinned.current || !selected?.element) return;
                            if (!selected.element.isConnected) { clearPinned(); setHighlight(null); return; }
                            const bounds = rect(selected.element.getBoundingClientRect());
                            setHighlight(current => current && Object.keys(bounds).every(k => current[k as keyof FeedbackRect] === bounds[k as keyof FeedbackRect]) ? current : bounds);
                            outlineFrame.current = requestAnimationFrame(follow);
                        };
                        follow();
                        highlightExpiry.current = setTimeout(() => { clearPinned(); setHighlight(null); }, 10000);
                    }
                    return null;
                }
                case 'crop-target': {
                    clearPinned(); setHighlight(null);
                    const api = globalThis as typeof globalThis & {
                        CropTarget?: {
                            fromElement(e: Element): Promise<unknown>;
                        };
                    };
                    return api.CropTarget?.fromElement(document.documentElement) ?? null;
                }
                case 'legacy-read': {
                    const d = await readDraft(key);
                    return d && validDraft(d) ? d : null;
                }
                case 'legacy-delete':
                    if (o.requestId && o.revision !== undefined)
                        await deleteDraft(key, o.requestId, o.revision);
                    return null;
                case 'submit': {
                    if (!o.draft || !validDraft(o.draft) || o.draft.key !== key)
                        throw new Error('Feedback belongs to a different source or account.');
                    const body = JSON.stringify(await submission(o.draft));
                    if (!live || route !== location.href)
                        throw new Error('The source document changed before submission.');
                    const response = await appFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
                    const result = await response.json().catch(() => null);
                    let reviewTargets: unknown[] = [];
                    if (response.ok && capabilities.administrator && result?.status === 'submitted' && typeof result.id === 'string') {
                        try {
                            const review = await appFetch(path + '/' + encodeURIComponent(result.id) + '/review-targets');
                            if (review.ok)
                                reviewTargets = (await review.json()).targets ?? [];
                        }
                        catch { /* Submission is already durable; review links are optional. */ }
                    }
                    return { ok: response.ok, status: response.status, result, reviewTargets };
                }
                default: throw new Error('Unsupported capture operation.');
            }
        };
        const register = () => {
            if ('feedback' in client) {
                const bootstrap = client.getSnapshot().bootstrap;
                const own = bootstrap?.app;
                if (bootstrap?.userId !== capabilities.userId || own?.appId !== capabilities.appId || own.installationId !== capabilities.installation)
                    return;
                client.feedback.register({ id: FEEDBACK_ROOT, capabilities, label: document.title || capabilities.appId, route: location.pathname, workspaceId: 'default', visible: () => live, invoke });
            }
            else
                client.registerFeedbackSource(capabilities, invoke);
        };
        let registeredRoute = location.href;
        const stopNavigation = client.subscribeNavigation(() => {
            if (location.href !== registeredRoute) { registeredRoute = location.href; selections.current.clear(); finish(null); }
            register();
        });
        register();
        const unsubscribe = client.subscribe(event => { if (event.type === 'environment' && event.value.connection === 'connected')
            register(); });
        return () => { live = false; finish(null); stopNavigation(); unsubscribe(); if ('feedback' in client)
            client.feedback.remove(FEEDBACK_ROOT);
        else
            client.unregisterFeedbackSource(); };
    }, [active, capabilities, client, path]);
    useEffect(() => {
        if (!active)
            return;
        let start: {
            x: number;
            y: number;
        } | null = null;
        const inside = (event: Event) => event.composedPath().some(n => n instanceof Element && n.hasAttribute('data-hosty-feedback-control'));
        const clearHover = () => { start = null; if (!pinned.current) setHighlight(null); };
        resetPick.current = clearHover;
        const leaves = (e: PointerEvent) => { if (!(e.relatedTarget instanceof Element) || e.relatedTarget instanceof HTMLIFrameElement || e.relatedTarget.ownerDocument !== document)
            clearHover(); };
        const move = (e: PointerEvent) => {
            if(!pickMode.current)return;
            if (inside(e)) {
                clearHover();
                return;
            }
            if (pickMode.current === 'region' && start)
                setHighlight({ x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(start.x - e.clientX), height: Math.abs(start.y - e.clientY) });
            else if (pickMode.current === 'element') {
                const element = document.elementFromPoint(e.clientX, e.clientY);
                setHighlight(element && !(element instanceof HTMLIFrameElement) ? rect(element.getBoundingClientRect()) : null);
            }
        };
        let stopClickGuard = () => {};
        const down = (e: PointerEvent) => {
            stopClickGuard();
            if(!pickMode.current)return;
            if (inside(e))
                return;
            const element = document.elementFromPoint(e.clientX, e.clientY);
            if (!element || element instanceof HTMLIFrameElement)
                return;
            e.preventDefault();
            e.stopImmediatePropagation();
            let released = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const swallow = (click: MouseEvent) => {
                // A region drag may click the common ancestor of its down/up targets. The next
                // pointerdown clears this guard, so a later unrelated gesture is never swallowed.
                if (released || click.composedPath().includes(element)) { click.preventDefault(); click.stopImmediatePropagation(); }
                cleanup();
            };
            const releasedPointer = () => { released = true; timer = setTimeout(cleanup, 0); };
            const cleanup = () => {
                document.removeEventListener('click', swallow, true);
                window.removeEventListener('pointerup', releasedPointer, true);
                document.removeEventListener('pointercancel', cleanup, true);
                clearTimeout(timer);
            };
            stopClickGuard = cleanup;
            document.addEventListener('click', swallow, { capture: true, once: true });
            window.addEventListener('pointerup', releasedPointer, { capture: true, once: true });
            document.addEventListener('pointercancel', cleanup, { capture: true, once: true });
            if (pickMode.current === 'region') {
                start = { x: e.clientX, y: e.clientY };
                return;
            }
            const chosen = note({ kind: 'element', label: element.getAttribute('aria-label')?.slice(0, 200) || element.tagName.toLowerCase(), selector: element.id ? '#' + CSS.escape(element.id) : element.tagName.toLowerCase(), bounds: rect(element.getBoundingClientRect()), viewport: viewport() });
            finish(remember(chosen, element));
        };
        const up = (e: PointerEvent) => { if (!pickMode.current || !start)
            return; e.preventDefault(); e.stopImmediatePropagation(); const b = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(start.x - e.clientX), height: Math.abs(start.y - e.clientY) }; start = null; if (b.width > 3 && b.height > 3)
            finish(remember(note({ kind: 'region', label: 'Selected region', bounds: b, viewport: viewport() }))); };
        const click = (e: MouseEvent) => { if (pickMode.current && !inside(e)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        } };
        const key = (e: KeyboardEvent) => { if (pickMode.current && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
        const visibility = () => { if (document.visibilityState !== 'visible')
            clearHover(); };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerdown', down, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('pointerout', leaves, true);
        document.addEventListener('pointercancel', clearHover, true);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('blur', clearHover);
        return () => { stopClickGuard(); document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); document.removeEventListener('pointerout', leaves, true); document.removeEventListener('pointercancel', clearHover, true); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', clearHover); resetPick.current=()=>{}; };
    }, [active]);
    return active && highlight ? createPortal(<div data-hosty-feedback-highlight aria-hidden style={{ position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, left: highlight.x, top: highlight.y, width: highlight.width, height: highlight.height, border: '2px solid #65a30d', background: 'rgba(163,230,53,.12)', boxSizing: 'border-box' }}/>, document.body) : null;
}
