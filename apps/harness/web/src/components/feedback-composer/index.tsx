"use client";
import { useEffect, useRef, useState } from 'react';
import { useHostyUi } from '@hosty-sdk/app/ui/react';
import { connectFeedback, feedbackScope, captureStill, type FeedbackSource, type FeedbackPort, type FeedbackOperation, type DraftNote, type FeedbackDraft } from '@hosty-sdk/app/feedback/client';
import { blankDraft, readDraft, saveDraft, deleteDraft } from './draft';
import { CropPreview, ImagePreview } from './screenshot';
import { FeedbackSpeech } from './feedback-speech';
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
    useEffect(() => {
        const connection = connectFeedback(event => {
            if (event.type === 'sources') {
                setSources(event.sources);
                setSelected(current => current && event.sources[0] && current.capabilities.userId !== event.sources[0].capabilities.userId ? event.sources[0] : current ? event.sources.find(s => s.id === current.id) ?? current : event.sources.find(s => s.id === 'host') ?? event.sources[0] ?? null);
            }
            if (event.type === 'picking')
                setPicking(event.mode);
            if (event.type === 'selection') {
                setSelected(event.source);
                setIncoming(event.note);
            }
        });
        port.current = connection;
        return () => { port.current = null; connection.close(); };
    }, []);
    const request = (operation: FeedbackOperation) => port.current?.request(operation) ?? Promise.reject(new Error('Reconnect the workspace to continue.'));
    const available = !!selected && sources.some(s => s.id === selected.id);
    return <main className="feedback-composer" aria-label="Feedback draft">
    <label>Application / page<select disabled={blocked} aria-label="Feedback application" value={selected?.id ?? ''} onChange={e => { setSelected(sources.find(s => s.id === e.target.value) ?? null); setIncoming(null); }}>
      {!selected && <option value="">Choose a page</option>}{selected && !available && <option value={selected.id}>{selected.label} · unavailable</option>}
      {sources.map(s => <option key={s.id} value={s.id}>{s.label} · {s.id === 'host' ? 'host' : s.route}</option>)}
    </select></label>
    <div className="fc-actions">
      <button aria-pressed={picking === 'element'} disabled={!available || blocked} onClick={() => void request({ action: 'pick', mode: 'element' }).catch(e => setError(message(e)))}>Select element</button>
      <button aria-pressed={picking === 'region'} disabled={!available || blocked} onClick={() => void request({ action: 'pick', mode: 'region', sourceId: selected?.id }).catch(e => setError(message(e)))}>Select region</button>
      <button disabled={!available || blocked} onClick={() => void request({ action: 'page', sourceId: selected?.id }).then(n => setIncoming(n as DraftNote)).catch(e => setError(message(e)))}>Page comment</button>
    </div>
    {picking && <div data-hosty-feedback-control role="status" className="fc-selection">{picking === 'region' ? 'Select a region in the chosen application.' : 'Select an element in a visible application.'}<button onClick={() => void request({ action: 'cancel' })}>Cancel selection</button></div>}
    {error && <p role="alert">{error}</p>}
    {selected ? <DraftEditor key={feedbackScope(selected.capabilities)} source={selected} available={available} incoming={incoming} request={request} setBlocked={setBlocked}/> : <p role="status">Open a supported application to collect feedback.</p>}
  </main>;
}
function DraftEditor({ source, available, incoming, request, setBlocked }: {
    source: FeedbackSource;
    available: boolean;
    incoming: DraftNote | null;
    request: (operation: FeedbackOperation) => Promise<unknown>;
    setBlocked: (blocked: boolean) => void;
}) {
    const key = feedbackScope(source.capabilities);
    const [draft, setDraft] = useState<FeedbackDraft>(() => blankDraft(key)), [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [busy, setBusy] = useState(false), [dictating, setDictating] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [legacy, setLegacy] = useState(false), [editing, setEditing] = useState<string | null>(null);
    const [reviewTargets, setReviewTargets] = useState<{
        label: string;
        href: string;
    }[]>([]);
    const [preview, setPreview] = useState<{
        id: string;
        blob: Blob;
    } | null>(null), [capturing, setCapturing] = useState(false);
    useEffect(() => { setBlocked(!ready || saving || saveFailed || busy); }, [ready, saving, saveFailed, busy, setBlocked]);
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
        setEditing(incoming.id);
        // The note event is consumed once after restoration; persistence uses the current draft ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, incoming]);
    async function screenshot(id: string) {
        if (capture.current)
            return;
        const operation = new AbortController();
        capture.current = operation;
        setCapturing(true);
        setError('');
        try {
            let cropped = false;
            const blob = await captureStill(() => { }, operation.signal, c => { cropped = c; }, async (track) => {
                const cropTrack = track as MediaStreamTrack & {
                    cropTo?: (target: unknown) => Promise<void>;
                };
                if (!cropTrack?.cropTo)
                    return false;
                try {
                    const target = await call.current({ action: 'crop-target', sourceId: sourceId.current });
                    operation.signal.throwIfAborted();
                    if (!target)
                        return false;
                    await cropTrack.cropTo(target);
                    return true;
                }
                catch {
                    return false;
                }
            });
            if (live.current && !operation.signal.aborted) {
                setPreview({ id, blob });
                setNotice(cropped ? 'Captured the selected application.' : 'Automatic application cropping was unavailable. Review and crop the screenshot before including it.');
            }
        }
        catch (e) {
            if (live.current && !operation.signal.aborted)
                setError(message(e));
        }
        finally {
            capture.current = null;
            if (live.current)
                setCapturing(false);
        }
    }
    async function acceptImage(blob: Blob) {
        if (!preview)
            return;
        if (blob.size > source.capabilities.maxImageBytes)
            throw new Error('Crop a smaller area: each screenshot must fit within 2 MiB.');
        if (current.current.annotations.filter(n => n.id !== preview.id).reduce((sum, n) => sum + (n.image?.size ?? 0), 0) + blob.size > source.capabilities.maxTotalImageBytes)
            throw new Error('Screenshots may total at most 8 MiB.');
        noteChange(preview.id, { image: blob });
        setPreview(null);
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
    function reset() { const fresh = blankDraft(key); current.current = fresh; revision.current = 0; savedId.current = null; saveFailure.current = null; setSaveFailed(false); setDraft(fresh); setEditing(null); }
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
    const locked = !ready || draft.submitting || busy;
    return <>
    <p className="fc-muted">One application per report. Switching applications preserves each draft.</p>
    <small role="status">{!ready ? 'Loading draft…' : saving ? 'Saving…' : saveFailed ? 'Not saved locally' : draft.revision ? 'Saved locally' : 'New report'}</small>
    {!available && <p role="status">Reopen this application to select elements or submit its saved draft.</p>}
    {legacy && <p role="status">A previous draft is still saved in the source application. Finish this draft, then reopen the tool to recover it.</p>}
    <ol>{draft.annotations.map((n, index) => <li key={n.id}>
      <div className="fc-actions"><strong>{index + 1}. {n.target?.label ?? 'Page comment'}</strong><button disabled={locked} onClick={() => update({ annotations: current.current.annotations.filter(a => a.id !== n.id) })}>Remove</button></div>
      <p className="fc-muted">{n.route}</p>
      <label>Comment<textarea aria-label={`Comment ${index + 1}`} maxLength={2000} disabled={locked} value={n.text} onFocus={() => setEditing(n.id)} onChange={e => noteChange(n.id, { text: e.target.value })}/></label>
      {n.image && <><ImagePreview blob={n.image}/><button disabled={locked} onClick={() => noteChange(n.id, { image: undefined })}>Remove screenshot</button></>}
      {editing === n.id && <FeedbackSpeech path="/api/hosty/ui/feedback" disabled={locked} onBusyChange={setDictating} onText={text => noteChange(n.id, { text: (current.current.annotations.find(a => a.id === n.id)?.text + ' ' + text).trim().slice(0, 2000) })}/>}
      <div className="fc-actions"><button disabled={locked || capturing || !available} onClick={() => void screenshot(n.id)}>{capturing ? 'Capturing…' : 'Add screenshot'}</button>
        <button disabled={locked || dictating} onClick={() => { setEditing(null); void flush().catch(e => setError(message(e))); }}>Done</button></div>
    </li>)}</ol>
    <label>Overall comment (optional)<textarea maxLength={5000} disabled={locked} value={draft.comment} onChange={e => update({ comment: e.target.value })}/></label>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {reviewTargets.map(t => <p key={t.href}><a href={t.href} target="_blank" rel="noopener noreferrer">Review feedback in {t.label}</a></p>)}
    <footer><button disabled={!ready || busy} onClick={() => void discard()}>Discard draft</button><button className="fc-submit" disabled={!ready || busy || dictating || !available || !draft.annotations.length || draft.annotations.some(n => !n.text.trim())} onClick={() => void send()}>{busy ? 'Sending…' : draft.submitting ? 'Retry submission' : 'Submit feedback'}</button></footer>
    {preview && <CropPreview blob={preview.blob} onCancel={() => setPreview(null)} onAccept={acceptImage}/>}
  </>;
}
