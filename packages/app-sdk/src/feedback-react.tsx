"use client";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { APP_SESSION_RESTORED, appFetch } from "./browser-auth";
import { SdkChromeStyles } from "./sdk-chrome";
import { blankDraft, deleteDraft, draftKey, makeNote, readDraft, saveDraft, submission, type DraftNote, type FeedbackDraft } from "./feedback-draft";
import { FeedbackSpeech } from "./feedback-speech";
import { captureStill, cropStill } from "./feedback-capture";
import type { FeedbackCapabilities, FeedbackRect, FeedbackTarget } from "./feedback-types";

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!blob) { setUrl(""); return; } const value = URL.createObjectURL(blob); setUrl(value); return () => URL.revokeObjectURL(value); }, [blob]);
  return url;
}
function ImagePreview({ blob }: { blob: Blob }) { const url = useBlobUrl(blob); return url ? <img src={url} alt="Included screenshot" /> : null; }
const rect = (b: DOMRect): FeedbackRect => ({ x: b.x, y: b.y, width: b.width, height: b.height });
const viewport = () => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio });
const errorMessage = (e: unknown) => e instanceof Error ? e.message : "Feedback could not be saved.";

export function FeedbackCapture({ active, uiPath = "/api/hosty/ui" }: { active: boolean; uiPath?: string }) {
  const [capabilities, setCapabilities] = useState<FeedbackCapabilities | null>(null);
  const [unavailable, setUnavailable] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { const refresh = () => setRetry(r => r + 1); window.addEventListener(APP_SESSION_RESTORED, refresh); return () => window.removeEventListener(APP_SESSION_RESTORED, refresh); }, []);
  const path = uiPath.replace(/\/$/, "") + "/feedback";
  useEffect(() => {
    setCapabilities(null); setUnavailable("");
    if (!active) return;
    const controller = new AbortController();
    void appFetch(path, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 404 ? "Update Core and this app to enable feedback." : "Feedback is unavailable. Retry when access is restored.");
      const value = await response.json() as FeedbackCapabilities;
      if (value.version !== 1 || !value.userId || !value.appId || !value.installation || !value.coreId) throw new Error("Feedback capability response is incompatible.");
      if (!controller.signal.aborted) setCapabilities(value);
    }).catch(e => { if (!controller.signal.aborted) setUnavailable(errorMessage(e)); });
    return () => controller.abort();
  }, [active, path, retry]);
  if (!active || typeof document === "undefined") return null;
  return capabilities ? <FeedbackEditor key={draftKey(capabilities)} capabilities={capabilities} path={path} />
    : unavailable ? createPortal(<div data-hosty-feedback data-hosty-sdk className="hosty-feedback-launch">
      <SdkChromeStyles /><button title={unavailable} onClick={() => setRetry(r => r + 1)}>Retry feedback</button>
    </div>, document.body) : null;
}

function FeedbackEditor({ capabilities, path }: { capabilities: FeedbackCapabilities; path: string }) {
  const [dictating, setDictating] = useState(false);
  const [reviewTargets, setReviewTargets] = useState<{ label: string; href: string }[]>([]);
  const key = draftKey(capabilities);
  const [draft, setDraft] = useState<FeedbackDraft>(() => blankDraft(key));
  const current = useRef(draft), savedRevision = useRef(0), queue = useRef(Promise.resolve()), saveFailure = useRef<Error | null>(null);
  const live = useRef(true);
  const [ready, setReady] = useState(false), [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<"element" | "region" | null>(null);
  const [highlight, setHighlight] = useState<FeedbackRect | null>(null);
  const [edit, setEdit] = useState<{ id: string; where: "anchor" | "side" } | null>(null);
  const [hidden, setHidden] = useState(false), [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<{ id: string; blob: Blob } | null>(null);
  const elements = useRef(new Map<string, Element>());
  const capture = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    live.current = true;
    void readDraft(key).then(value => {
      if (!live.current) return;
      if (value) { current.current = value; savedRevision.current = value.revision; setDraft(value); setNotice("Saved draft restored."); }
    }).catch(e => { if (live.current) setError(errorMessage(e)); }).finally(() => { if (live.current) setReady(true); });
    return () => { live.current = false; capture.current?.abort(); };
  }, [key]);
  function update(change: Partial<FeedbackDraft>) {
    const next = { ...current.current, ...change, revision: current.current.revision + 1 };
    current.current = next; setDraft(next); setSaving(true); setNotice("");
    queue.current = queue.current.then(async () => {
      try {
        await saveDraft(next, savedRevision.current); savedRevision.current = next.revision; saveFailure.current = null;
        if (live.current) { setError(""); setSaving(current.current.revision !== next.revision); }
      } catch (e) {
        saveFailure.current = new Error(errorMessage(e));
        if (live.current) { setSaving(false); setError("Not saved locally: " + errorMessage(e)); }
      }
    });
  }
  async function flush() { await queue.current; if (saveFailure.current) throw saveFailure.current; }
  function noteChange(id: string, change: Partial<DraftNote>) {
    if (current.current.submitting) return;
    update({ annotations: current.current.annotations.map(n => n.id === id ? { ...n, ...change } : n) });
  }
  function add(target: FeedbackTarget, element?: Element) {
    if (current.current.annotations.length >= capabilities.maxAnnotations) { setError("A report can contain at most 20 annotations."); return; }
    const note = makeNote(target);
    if (element) elements.current.set(note.id, element);
    update({ annotations: [...current.current.annotations, note] }); setEdit({ id: note.id, where: "anchor" }); setPicking(null); setHighlight(target.bounds ?? null);
  }
  useEffect(() => {
    if (!picking || draft.submitting || !open) return;
    let start: { x: number; y: number } | null = null;
    const inside = (event: Event) => event.composedPath().some(node => node instanceof Element && node.hasAttribute("data-hosty-feedback"));
    const move = (event: PointerEvent) => {
      if (inside(event)) return;
      if (picking === "region" && start) setHighlight({ x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY),
        width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) });
      else if (picking === "element") {
        const element = document.elementFromPoint(event.clientX, event.clientY);
        if (element) setHighlight(rect(element.getBoundingClientRect()));
      }
    };
    const down = (event: PointerEvent) => {
      if (inside(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // React may remove the picker effect before the native click follows pointerup.
      const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopImmediatePropagation(); cleanup(); };
      const cleanup = () => { document.removeEventListener("click", swallow, true); clearTimeout(timer); };
      const timer = setTimeout(cleanup, 1500); document.addEventListener("click", swallow, { capture: true, once: true });
      if (picking === "region") { start = { x: event.clientX, y: event.clientY }; return; }
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element) return;
      // Never read input values, text content, or arbitrary data attributes into evidence.
      const label = element.getAttribute("aria-label")?.slice(0, 200) || element.tagName.toLowerCase();
      const selector = element.id ? "#" + CSS.escape(element.id) : element.tagName.toLowerCase();
      add({ kind: "element", label, selector, bounds: rect(element.getBoundingClientRect()), viewport: viewport() }, element);
    };
    const up = (event: PointerEvent) => {
      if (!start) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const b = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY),
        width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) }; start = null;
      if (b.width > 3 && b.height > 3) add({ kind: "region", label: "Selected region", bounds: b, viewport: viewport() });
    };
    const click = (event: MouseEvent) => { if (!inside(event)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setPicking(null); setHighlight(null); } };
    document.addEventListener("pointermove", move, true); document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true); document.addEventListener("click", click, true); document.addEventListener("keydown", escape, true);
    const old = document.documentElement.style.cursor; document.documentElement.style.cursor = "crosshair";
    return () => {
      document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", escape, true);
      document.documentElement.style.cursor = old;
    };
  }, [picking, draft.submitting, open]);
  const selected = draft.annotations.find(n => n.id === edit?.id);
  useEffect(() => {
    if (picking || !edit || !open) return;
    const refresh = () => {
      const element = elements.current.get(edit.id);
      setHighlight(element?.isConnected ? rect(element.getBoundingClientRect()) : current.current.annotations.find(n => n.id === edit.id)?.target?.bounds ?? null);
    };
    refresh(); window.addEventListener("scroll", refresh, true); window.addEventListener("resize", refresh);
    return () => { window.removeEventListener("scroll", refresh, true); window.removeEventListener("resize", refresh); };
  }, [edit, picking, open]);
  async function done() {
    setEdit(null); setHighlight(null);
    try { await flush(); } catch (e) { setError(errorMessage(e)); }
  }
  async function screenshot(id: string) {
    if (capture.current || draft.submitting) return;
    const operation = new AbortController(); capture.current = operation; setCapturing(true); setError("");
    try {
      const blob = await captureStill(value => { if (root.current) root.current.style.visibility = value ? "hidden" : ""; setHidden(value); }, operation.signal);
      if (live.current && !operation.signal.aborted) setPreview({ id, blob });
    } catch (e) { if (live.current && !operation.signal.aborted) setError(errorMessage(e)); }
    finally { if (capture.current === operation) capture.current = null; if (live.current) setCapturing(false); }
  }
  async function acceptImage(blob: Blob) {
    if (!preview) return;
    if (blob.size > capabilities.maxImageBytes) { setError("Crop a smaller area: each screenshot must fit within 2 MiB."); return; }
    const total = current.current.annotations.filter(n => n.id !== preview.id).reduce((sum, n) => sum + (n.image?.size ?? 0), 0) + blob.size;
    if (total > capabilities.maxTotalImageBytes) { setError("Screenshots may total at most 8 MiB. Remove or crop an existing image."); return; }
    noteChange(preview.id, { image: blob }); setPreview(null);
  }
  async function send() {
    if (busy || !current.current.annotations.length || current.current.annotations.some(n => !n.text.trim())) return;
    setBusy(true); setError("");
    try {
      update({ submitting: true }); await flush();
      const frozen = current.current;
      const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await submission(frozen)) });
      const result = await response.json().catch(() => null) as { id?: string; status?: string; message?: string } | null;
      if (!response.ok) {
        if ([400, 413, 415].includes(response.status)) update({ submitting: false, requestId: crypto.randomUUID() });
        throw new Error(result?.message ?? "Submission was not confirmed. Retry the same feedback; your draft is retained.");
      }
      if (!result || !["submitted", "deleted"].includes(result.status ?? "")) throw new Error("Submission was not confirmed. Retry the same feedback.");
      await deleteDraft(key, frozen.requestId);
      const fresh = blankDraft(key); savedRevision.current = 0; current.current = fresh; setDraft(fresh);
      setReviewTargets([]);
      if (capabilities.administrator && result.status === "submitted" && result.id) {
        void appFetch(path + "/" + encodeURIComponent(result.id) + "/review-targets").then(async response => {
          if (!response.ok) return;
          const value = await response.json();
          if (live.current) setReviewTargets(value.targets ?? []);
        }).catch(() => undefined);
      }
      setEdit(null); setHighlight(null); setNotice(result.status === "deleted" ? "This feedback was already submitted and subsequently removed with its workspace." : "Feedback submitted.");
    } catch (e) { setError(errorMessage(e)); } finally { if (live.current) setBusy(false); }
  }
  async function discard() {
    if (!window.confirm(current.current.submitting ? "This submission may already exist. Discard its local retry record? This does not delete a submitted feedback." : "Discard this local feedback draft and its screenshots?")) return;
    try {
      await queue.current; await deleteDraft(key, current.current.requestId);
      const fresh = blankDraft(key); savedRevision.current = 0; saveFailure.current = null; current.current = fresh; setDraft(fresh);
      setEdit(null); setHighlight(null); setError(""); setNotice("Draft discarded.");
    } catch (e) { setError(errorMessage(e)); }
  }
  function editor(note: DraftNote) {
    return <><label>Comment<textarea aria-label="Comment" autoFocus maxLength={2000} value={note.text} disabled={draft.submitting}
      onChange={event => noteChange(note.id, { text: event.target.value })} placeholder="What should change here?" /></label>
      <FeedbackSpeech path={path} disabled={draft.submitting} onBusyChange={setDictating} onText={text => {
        const old = current.current.annotations.find(n => n.id === note.id); if (!old) return;
        const next = [old.text, text].filter(Boolean).join(" ");
        if (next.length > 2000) { setError("Dictation exceeds the comment limit. Shorten the comment before dictating again."); return; }
        noteChange(note.id, { text: next });
      }} />
      <div className="hf-actions"><button onClick={() => void screenshot(note.id)} disabled={capturing || draft.submitting}>Add screenshot</button>
        <button disabled={dictating} onClick={() => void done()}>Done</button></div></>;
  }
  const popup: CSSProperties = { left: Math.max(12, Math.min(highlight?.x ?? 24, innerWidth - 340)),
    top: Math.max(12, Math.min((highlight?.y ?? 40) + (highlight?.height ?? 0) + 12, innerHeight - 250)) };
  if (!ready) return null;
  return createPortal(<div ref={root} data-hosty-feedback data-hosty-sdk style={{ visibility: hidden ? "hidden" : undefined }}>
    <SdkChromeStyles /><style>{feedbackStyles}</style>
    {!open && <button className="hosty-feedback-launch" onClick={() => setOpen(true)}>Annotate{draft.annotations.length ? " · " + draft.annotations.length : ""}</button>}
    {open && <>
      {picking && <div className="hosty-feedback-launch" role="status">{picking === "element" ? "Select an element" : "Drag a region"} · Escape cancels <button onClick={() => { setPicking(null); setHighlight(null); }}>Cancel selection</button></div>}
      <aside className="hf-panel" aria-label="Feedback draft" style={{ visibility: picking ? "hidden" : undefined,
        ...(edit?.where === "anchor" && highlight && highlight.x > innerWidth - 400 ? { left: 12, right: "auto" } : {}) }}>
        <header><div><strong>Feedback</strong><small>{saving ? "Saving…" : saveFailure.current ? "Not saved locally" : draft.revision ? "Saved locally" : "New report"}</small></div>
          <button aria-label="Close feedback" onClick={() => { setOpen(false); setPicking(null); capture.current?.abort(); }}>×</button></header>
        <p>Collect related comments, then send them as one feedback.</p>
        <div className="hf-actions">
          <button disabled={draft.submitting} aria-pressed={picking === "element"} onClick={() => { setEdit(null); setPicking("element"); }}>Select element</button>
          <button disabled={draft.submitting} aria-pressed={picking === "region"} onClick={() => { setEdit(null); setPicking("region"); }}>Select region</button>
          <button disabled={draft.submitting} onClick={() => add({ kind: "page", label: "This page", viewport: viewport() })}>Page comment</button>
        </div>
        {picking && <p role="status">{picking === "element" ? "Click an element to annotate it." : "Drag over the area to annotate."} Escape cancels selection.</p>}
        <ol>{draft.annotations.map((note, index) => <li key={note.id}>
          <div className="hf-note-heading"><button onClick={() => { setPicking(null); setEdit({ id: note.id, where: "anchor" }); elements.current.get(note.id)?.scrollIntoView({ block: "nearest" }); }}>
            {index + 1}. {note.target?.label ?? "Annotation"}</button>
            <button disabled={draft.submitting} onClick={() => { update({ annotations: current.current.annotations.filter(n => n.id !== note.id) }); if (edit?.id === note.id) setEdit(null); }}>Remove</button></div>
          {edit?.id === note.id && edit.where === "side" ? editor(note) : <><p>{note.text || "Add a comment…"}</p>
            <button onClick={() => { setPicking(null); setEdit({ id: note.id, where: "side" }); }}>Edit</button></>}
          {note.image && <><ImagePreview blob={note.image} /><button disabled={draft.submitting} onClick={() => noteChange(note.id, { image: undefined })}>Remove screenshot</button></>}
        </li>)}</ol>
        <label>Overall comment (optional)<textarea maxLength={5000} value={draft.comment} disabled={draft.submitting} onChange={event => update({ comment: event.target.value })} /></label>
        {error && <p role="alert" className="hf-error">{error}</p>}{notice && <p role="status">{notice}</p>}
        {reviewTargets.map(target => <p key={target.href}><a href={target.href} target="_blank" rel="noopener noreferrer">Send to chat in {target.label}</a></p>)}
        {draft.submitting && !busy && <p>The submission may already have reached Core. Retry to recover its confirmation.</p>}
        <footer><button onClick={() => void discard()} disabled={busy}>Discard draft</button>
          <button className="hf-primary" disabled={busy || dictating || capturing || !draft.annotations.length || draft.annotations.some(n => !n.text.trim())}
            onClick={() => void send()}>{busy ? "Sending…" : draft.submitting ? "Retry submission" : "Submit feedback"}</button></footer>
      </aside>
      {highlight && <div className="hf-highlight" aria-hidden style={{ left: highlight.x, top: highlight.y, width: highlight.width, height: highlight.height }} />}
      {selected && edit?.where === "anchor" && !picking && <section className="hf-popover" role="dialog" aria-label="Annotation comment" style={popup}>
        <strong>{selected.target?.label ?? "Annotation"}</strong>{editor(selected)}
      </section>}
      {preview && <CropPreview blob={preview.blob} onCancel={() => setPreview(null)} onAccept={acceptImage} />}
    </>}
  </div>, document.body);
}

function CropPreview({ blob, onCancel, onAccept }: { blob: Blob; onCancel: () => void; onAccept: (blob: Blob) => Promise<void> }) {
  const url = useBlobUrl(blob); const [crop, setCrop] = useState<FeedbackRect | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current; node?.showModal();
    return () => { node?.close(); };
  }, []);
  const start = useRef<{ x: number; y: number } | null>(null);
  const point = (event: ReactPointerEvent<HTMLDivElement>) => { const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.x) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.y) / bounds.height)) }; };
  return <dialog ref={dialog} className="hf-crop" aria-label="Review screenshot" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2>Review screenshot</h2><p>Check the selected source. Drag to crop, or adjust the percentages below. Only the approved image is included.</p>
    <div className="hf-crop-image" onPointerDown={event => { start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!start.current) return; const p = point(event); setCrop({ x: Math.min(p.x, start.current.x), y: Math.min(p.y, start.current.y),
        width: Math.abs(p.x - start.current.x), height: Math.abs(p.y - start.current.y) }); }} onPointerUp={() => { start.current = null; }}>
      {url && <img src={url} alt="Captured screen for review" draggable={false} />}
      {crop && <div className="hf-crop-selection" style={{ left: crop.x * 100 + "%", top: crop.y * 100 + "%", width: crop.width * 100 + "%", height: crop.height * 100 + "%" }} />}
    </div>
    <div className="hf-actions">{(["x", "y", "width", "height"] as const).map(field => <label key={field}>{field === "x" ? "Left %" : field === "y" ? "Top %" : field === "width" ? "Width %" : "Height %"}
      <input type="number" min={0} max={100} value={Math.round((crop?.[field] ?? (field === "width" || field === "height" ? 1 : 0)) * 100)}
        onChange={event => setCrop({ ...(crop ?? { x: 0, y: 0, width: 1, height: 1 }), [field]: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} /></label>)}</div>
    {error && <p role="alert">{error}</p>}<footer><button onClick={onCancel} disabled={busy}>Cancel</button><button onClick={() => setCrop(null)}>Use full image</button>
      <button className="hf-primary" disabled={busy || !!crop && (!crop.width || !crop.height)} onClick={() => { setBusy(true); void cropStill(blob, crop).then(onAccept).catch(e => setError(errorMessage(e))).finally(() => setBusy(false)); }}>Include screenshot</button></footer>
  </dialog>;
}
const feedbackStyles = [
  "[data-hosty-feedback]{font-family:var(--hs-font);font-size:14px;color:#0f1b2d;line-height:1.45}",
  ".hosty-feedback-launch{position:fixed;left:16px;bottom:16px;z-index:2147481000;background:#fff;border:1px solid #bdc8d6;border-radius:20px;padding:10px 16px;box-shadow:0 3px 14px #0f1b2d20}",
  "[data-hosty-feedback] button{font:inherit;cursor:pointer;border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 10px;color:#0f1b2d}",
  "[data-hosty-feedback] button:disabled{opacity:.5;cursor:not-allowed}[data-hosty-feedback] button:focus-visible,[data-hosty-feedback] textarea:focus{outline:2px solid #65a30d;outline-offset:2px}",
  "[data-hosty-feedback] textarea{box-sizing:border-box;display:block;width:100%;min-height:90px;font:inherit;color:#0f1b2d;background:#fff;border:1px solid #cbd5e1;border-radius:7px;padding:8px;resize:vertical;margin:6px 0}",
  "[data-hosty-feedback] .hf-primary{background:#a3e635;border-color:#84cc16}[data-hosty-feedback] .hf-error{color:#b91c1c}",
  ".hf-panel{box-sizing:border-box;position:fixed;right:12px;top:12px;bottom:12px;width:min(360px,calc(100vw - 24px));background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:16px;box-shadow:0 10px 45px #0f1b2d30;overflow:auto;z-index:2147481001}",
  ".hf-panel header,.hf-note-heading,.hf-panel footer,.hf-crop footer{display:flex;justify-content:space-between;align-items:center;gap:8px}.hf-panel small{display:block;color:#64748b}.hf-panel ol{padding:0;list-style:none}.hf-panel li{border:1px solid #e2e8f0;border-radius:9px;padding:10px;margin:12px 0}.hf-panel p{white-space:pre-wrap;overflow-wrap:anywhere}.hf-panel img{max-width:100%;border-radius:6px;margin:8px 0}.hf-panel footer{margin-top:14px}",
  ".hf-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.hf-highlight{position:fixed;border:2px solid #65a30d;box-shadow:0 0 0 2px #ecfccb;pointer-events:none;z-index:2147481000;background:#a3e63518;box-sizing:border-box}",
  ".hf-popover>strong{display:block;margin-bottom:6px}.hf-popover{position:fixed;width:min(310px,calc(100vw - 32px));box-sizing:border-box;z-index:2147481002;background:#fff;border:1px solid #84cc16;border-radius:10px;padding:12px;box-shadow:0 8px 28px #0f1b2d35}",
  ".hf-backdrop{position:fixed;inset:0;background:#0f1b2d88;display:grid;place-items:center;z-index:2147481003;padding:16px}.hf-crop::backdrop{background:#0f1b2d88}.hf-crop{border:0;color:#0f1b2d;background:#fff;border-radius:12px;padding:20px;width:min(760px,90vw);max-height:90vh;overflow:auto}.hf-crop-image{position:relative;display:table;max-width:100%;touch-action:none}.hf-crop-image img{display:block;max-width:100%;max-height:55vh;user-select:none}.hf-crop-selection{position:absolute;border:2px solid #65a30d;background:#a3e63530;pointer-events:none;box-sizing:border-box}.hf-crop input{display:block;width:70px}"
].join("\n");

