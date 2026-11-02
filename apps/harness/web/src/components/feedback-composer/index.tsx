"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostyUi } from '@hosty-sdk/app/ui/react';
import { connectFeedback, feedbackScope, captureScreen, type FeedbackSource, type FeedbackPort, type FeedbackOperation, type DraftNote, type FeedbackDraft } from '@hosty-sdk/app/feedback/client';
import { blankDraft, readDraft, saveDraft, deleteDraft } from './draft';
import { FeedbackCommentInput } from './comment-input';
import { useFeedbackSpeech } from './feedback-speech';
import { useAutomaticScreenshot, type AutomaticScreenshot } from './automatic-screenshot';
import './style.css';
const message = (e: unknown) => e instanceof Error ? e.message : 'Feedback is unavailable.';
export function FeedbackComposer() {
    const ui = useHostyUi();
    useEffect(() => {
        const route = new URL(window.location.href);
        ui.reportSurfaceState({ route: route.pathname + route.search, state: "ready" });
    }, [ui]);
    const [sources, setSources] = useState<FeedbackSource[]>([]), [selected, setSelected] = useState<FeedbackSource | null>(null);
    const [incoming, setIncoming] = useState<DraftNote | null>(null), [picking, setPicking] = useState<'element' | 'region' | null>(null), [error, setError] = useState('');
    const port = useRef<FeedbackPort | null>(null);
    const [blocked,setBlocked] = useState(true);
    const request = useCallback((operation: FeedbackOperation) => port.current?.request(operation) ?? Promise.reject(new Error('Reconnect the workspace to continue.')), []);
    const screenshot = useAutomaticScreenshot(request);
    const receiveCapture = screenshot.receive;
    useEffect(() => {
        const connection = connectFeedback(event => {
            const heldForCapture = receiveCapture(event);
            if (event.type === 'sources') {
                setSources(event.sources);
                setSelected(current => current && event.sources[0] && current.capabilities.userId !== event.sources[0].capabilities.userId ? event.sources[0] : current ? event.sources.find(s => s.id === current.id) ?? current : event.sources.find(s => s.id === 'host') ?? event.sources[0] ?? null);
            }
            if (event.type === 'picking')
                setPicking(event.mode);
            if (event.type === 'selection' && !heldForCapture) {
                setSelected(event.source);
                setIncoming(event.note);
            }
        });
        port.current = connection;
        return () => { port.current = null; connection.close(); };
    }, [receiveCapture]);
    const available = !!selected && sources.some(s => s.id === selected.id);
    const capturing = screenshot.phase !== null;
    const select = (mode: 'element' | 'region' | 'page') => { if (selected) void screenshot.start(mode, selected, event => { setSelected(event.source); setIncoming(event.note); }); };
    return <main className="feedback-composer" aria-label="Feedback draft">
    <label>Application / page<select disabled={blocked || capturing} aria-label="Feedback application" value={selected?.id ?? ''} onChange={e => { setSelected(sources.find(s => s.id === e.target.value) ?? null); setIncoming(null); }}>
      {!selected && <option value="">Choose a page</option>}{selected && !available && <option value={selected.id}>{selected.label} · unavailable</option>}
      {sources.map(s => <option key={s.id} value={s.id}>{s.label} · {s.id === 'host' ? 'host' : s.route}</option>)}
    </select></label>
    <div className="fc-actions">
      <button aria-pressed={picking === 'element'} disabled={!available || blocked || capturing} onClick={() => select('element')}>Select element</button>
      <button aria-pressed={picking === 'region'} disabled={!available || blocked || capturing} onClick={() => select('region')}>Select region</button>
      <button disabled={!available || blocked || capturing} onClick={() => select('page')}>Page comment</button>
    </div>
    <label className="fc-screenshot-option"><input type="checkbox" checked={screenshot.enabled} disabled={blocked || capturing || !!picking} onChange={e => screenshot.setEnabled(e.target.checked)}/> Include screenshot</label>
    {capturing && !picking && <p role="status">{screenshot.phase === 'permission' ? 'Choose the screen, window or tab to capture.' : 'Capturing the selected surface…'} <button onClick={screenshot.cancel}>Cancel capture</button></p>}
    {screenshot.notice && <p role="status">{screenshot.notice}</p>}
    {picking && <div data-hosty-feedback-control role="status" className="fc-selection">{picking === 'region' ? 'Select a region in the chosen application.' : 'Select an element in a visible application.'}<button onClick={() => { screenshot.cancel(); void request({ action: 'cancel' }).catch(e => setError(message(e))); }}>Cancel selection</button></div>}
    {error && <p role="alert">{error}</p>}
    {selected ? <DraftEditor key={feedbackScope(selected.capabilities)} source={selected} available={available} incoming={incoming} request={request} setBlocked={setBlocked} captureBusy={capturing} automaticScreenshot={screenshot.result} onScreenshotConsumed={screenshot.clearResult}/> : <p role="status">Open a supported application to collect feedback.</p>}
  </main>;
}
function DraftEditor({ source, available, incoming, request, setBlocked, captureBusy, automaticScreenshot, onScreenshotConsumed }: {
    source: FeedbackSource;
    available: boolean;
    incoming: DraftNote | null;
    request: (operation: FeedbackOperation) => Promise<unknown>;
    setBlocked: (blocked: boolean) => void;
    captureBusy: boolean;
    automaticScreenshot: AutomaticScreenshot | null;
    onScreenshotConsumed: () => void;
}) {
    const key = feedbackScope(source.capabilities);
    const [draft, setDraft] = useState<FeedbackDraft>(() => blankDraft(key)), [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [busy, setBusy] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [legacy, setLegacy] = useState(false);
    const [reviewTargets, setReviewTargets] = useState<{
        label: string;
        href: string;
    }[]>([]);
    const [capturing, setCapturing] = useState(false), [imageError, setImageError] = useState('');
    const pendingImage = !!automaticScreenshot && feedbackScope(automaticScreenshot.source.capabilities) === key;
    const locked = !ready || draft.submitting || busy || capturing || captureBusy || pendingImage;
    const speech = useFeedbackSpeech("/api/hosty/ui/feedback", locked);
    const dictating = speech.phase !== "idle";
    useEffect(() => { setBlocked(!ready || saving || saveFailed || busy || capturing || pendingImage || dictating); }, [ready, saving, saveFailed, busy, capturing, pendingImage, dictating, setBlocked]);
    const consumedImage = useRef<AutomaticScreenshot | null>(null);
    const current = useRef(draft), revision = useRef(0), savedId = useRef<string | null>(null), queue = useRef(Promise.resolve()), saveFailure = useRef<Error | null>(null), live = useRef(true), capture = useRef<AbortController | null>(null), seen = useRef(new Set<string>());
    const call = useRef(request);
    const sourceId = useRef(source.id);
    useEffect(() => { call.current = request; sourceId.current = source.id; }, [request, source.id]);
    useEffect(() => {
        live.current = true;
        void (async () => {
            let value = await readDraft(key);
            // Explicitly opened composer imports only the chosen source's legacy draft. Save first;
            // deleting the source copy is revision-checked and can always be retried after a crash.
            let previous: FeedbackDraft | null = null;
            try {
                previous = await call.current({ action: 'legacy-read', sourceId: sourceId.current }) as FeedbackDraft | null;
            }
            catch {
                if (live.current)
                    setNotice('Source draft recovery is unavailable. Reopen the tool when the application is connected.');
            }
            if (!value && previous) {
                await saveDraft(previous, 0, null);
                value = previous;
            }
            if (previous && value?.requestId === previous.requestId && value.revision === previous.revision) {
                try {
                    await call.current({ action: 'legacy-delete', sourceId: sourceId.current, requestId: previous.requestId, revision: previous.revision });
                }
                catch {
                    if (live.current)
                        setLegacy(true);
                }
            }
            else if (previous && live.current)
                setLegacy(true);
            if (!live.current)
                return;
            if (value) {
                current.current = value;
                revision.current = value.revision;
                savedId.current = value.requestId;
                setDraft(value);
                setNotice('Saved draft restored.');
            }
            setReady(true);
        })().catch(e => { if (live.current)
            setError(message(e)); });
        return () => { live.current = false; capture.current?.abort(); };
    }, [key]);
    function update(change: Partial<FeedbackDraft>) {
        const next = { ...current.current, ...change, revision: current.current.revision + 1 };
        current.current = next;
        setDraft(next);
        setSaving(true);
        setNotice('');
        queue.current = queue.current.then(async () => {
            try {
                await saveDraft(next, revision.current, savedId.current);
                revision.current = next.revision;
                savedId.current = next.requestId;
                saveFailure.current = null;
                if (live.current) {
                    setSaving(current.current.revision !== next.revision);
                    setError('');
                    setSaveFailed(false);
                }
            }
            catch (e) {
                saveFailure.current = new Error(message(e));
                if (live.current) {
                    setSaving(false);
                    setSaveFailed(true);
                    setError('Not saved locally: ' + message(e));
                }
            }
        });
    }
    async function flush() { await queue.current; if (saveFailure.current)
        throw saveFailure.current; }
    function noteChange(id: string, change: Partial<DraftNote>) { if (!current.current.submitting)
        update({ annotations: current.current.annotations.map(n => n.id === id ? { ...n, ...change } : n) }); }
    useEffect(() => {
        if (!ready || !incoming || seen.current.has(incoming.id))
            return;
        seen.current.add(incoming.id);
        if (current.current.submitting) {
            setError('Retry or discard the pending submission before adding comments.');
            return;
        }
        if (current.current.annotations.length >= source.capabilities.maxAnnotations) {
            setError('This report already contains 20 annotations.');
            return;
        }
        update({ annotations: [...current.current.annotations, incoming] });
        // The note event is consumed once after restoration; persistence uses the current draft ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, incoming]);
    function attachImage(id: string, blob: Blob) {
        if (current.current.submitting || !current.current.annotations.some(n => n.id === id)) return;
        if (blob.size > source.capabilities.maxImageBytes)
            throw new Error('Screenshot not added: each image must fit within 2 MiB. You can retake it or continue without it.');
        if (current.current.annotations.filter(n => n.id !== id).reduce((sum, n) => sum + (n.image?.size ?? 0), 0) + blob.size > source.capabilities.maxTotalImageBytes)
            throw new Error('Screenshot not added: images may total at most 8 MiB. Remove another screenshot or continue without this one.');
        noteChange(id, { image: blob });
        setImageError('');
    }
    useEffect(() => {
        if (!ready || !automaticScreenshot || !pendingImage || consumedImage.current === automaticScreenshot || !seen.current.has(automaticScreenshot.note.id)) return;
        consumedImage.current = automaticScreenshot;
        try {
            attachImage(automaticScreenshot.note.id, automaticScreenshot.blob);
        } catch (e) {
            // Consume the external capture result once after asynchronous draft restoration.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setImageError(message(e));
        }
        onScreenshotConsumed();
        // Consume each capture once, after its note is accepted or rejected against the restored draft.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, incoming, automaticScreenshot, pendingImage, onScreenshotConsumed]);
    async function screenshot(id: string) {
        if (capture.current)
            return;
        const operation = new AbortController();
        capture.current = operation;
        setCapturing(true);
        setImageError('');
        try {
            const blob = await captureScreen(operation.signal);
            if (live.current && !operation.signal.aborted) attachImage(id, blob);
        }
        catch (e) {
            if (live.current && !operation.signal.aborted)
                setImageError(message(e));
        }
        finally {
            capture.current = null;
            if (live.current)
                setCapturing(false);
        }
    }
    async function send() {
        setBusy(true);
        setError('');
        try {
            if (!current.current.submitting)
                update({ submitting: true });
            await flush();
            const frozen = current.current;
            const response = await request({ action: 'submit', sourceId: source.id, draft: frozen }) as {
                ok: boolean;
                status: number;
                result: {
                    status?: string;
                    message?: string;
                };
                reviewTargets?: {
                    label: string;
                    href: string;
                }[];
            };
            if (!response.ok) {
                if ([400, 413, 415].includes(response.status))
                    update({ submitting: false, requestId: crypto.randomUUID() });
                throw new Error(response.result?.message ?? 'Submission was not confirmed. Retry the same feedback.');
            }
            if (!['submitted', 'deleted'].includes(response.result?.status ?? ''))
                throw new Error('Submission was not confirmed. Retry the same feedback.');
            await deleteDraft(key, frozen.requestId, frozen.revision);
            reset();
            setReviewTargets(response.reviewTargets ?? []);
            setNotice('Feedback submitted.');
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    }
    function reset() { const fresh = blankDraft(key); current.current = fresh; revision.current = 0; savedId.current = null; saveFailure.current = null; setSaveFailed(false); setDraft(fresh); setImageError(''); }
    async function discard() {
        if (!window.confirm(draft.submitting ? 'This submission may already exist. Discard its local retry record?' : 'Discard this feedback draft and screenshots?'))
            return;
        try {
            await queue.current;
            await deleteDraft(key, current.current.requestId, revision.current);
            reset();
            setError('');
        }
        catch (e) {
            setError(message(e));
        }
    }
    return <>
    <p className="fc-muted">One application per report. Switching applications preserves each draft.</p>
    <small role="status">{!ready ? 'Loading draft…' : saving ? 'Saving…' : saveFailed ? 'Not saved locally' : draft.revision ? 'Saved locally' : 'New report'}</small>
    {!available && <p role="status">Reopen this application to select elements or submit its saved draft.</p>}
    {legacy && <p role="status">A previous draft is still saved in the source application. Finish this draft, then reopen the tool to recover it.</p>}
    {speech.providers.length > 1 && <label>Speech provider<select value={speech.choice} disabled={locked || dictating} onChange={e => speech.setChoice(e.target.value)}>
      <option value="">Choose provider</option>{speech.providers.map(p => <option key={JSON.stringify([p.appId, p.key])} value={JSON.stringify([p.appId, p.key])} disabled={!p.available}>{p.displayName}</option>)}
    </select></label>}
    <ol>{draft.annotations.map((n, index) => <li key={n.id}>
      <div className="fc-actions"><strong>{index + 1}. {n.target?.label ?? 'Page comment'}</strong><button disabled={locked || dictating} onClick={() => update({ annotations: current.current.annotations.filter(a => a.id !== n.id) })}>Remove</button></div>
      <p className="fc-muted">{n.route}</p>
      <FeedbackCommentInput label="Comment" ariaLabel={`Comment ${index + 1}`} target={`annotation:${n.id}`} value={n.text}
        maxLength={2000} disabled={locked} speech={speech} onChange={text => noteChange(n.id, { text })}
        onDictation={text => noteChange(n.id, { text: ((current.current.annotations.find(a => a.id === n.id)?.text ?? '') + ' ' + text).trim().slice(0, 2000) })}
        screenshot={{ image: n.image, capturing, available, capture: () => void screenshot(n.id), remove: () => noteChange(n.id, { image: undefined }) }}
        onDone={() => { void flush().catch(e => setError(message(e))); }} />
    </li>)}</ol>
    <FeedbackCommentInput label="Overall comment (optional)" target="overall" value={draft.comment}
      maxLength={5000} disabled={locked} speech={speech} onChange={comment => update({ comment })}
      onDictation={text => update({ comment: (current.current.comment + ' ' + text).trim().slice(0, 5000) })} />
    {error && <p role="alert">{error}</p>}{imageError && <p role="alert">{imageError}</p>}{notice && <p role="status">{notice}</p>}
    {reviewTargets.map(t => <p key={t.href}><a href={t.href} target="_blank" rel="noopener noreferrer">Review feedback in {t.label}</a></p>)}
    <footer><button disabled={!ready || busy || captureBusy || capturing || pendingImage || dictating} onClick={() => void discard()}>Discard draft</button><button className="fc-submit" disabled={!ready || busy || captureBusy || capturing || pendingImage || dictating || !available || !draft.annotations.length || draft.annotations.some(n => !n.text.trim())} onClick={() => void send()}>{busy ? 'Sending…' : draft.submitting ? 'Retry submission' : 'Submit feedback'}</button></footer>
  </>;
}
