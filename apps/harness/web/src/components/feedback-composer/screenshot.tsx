/* eslint-disable @next/next/no-img-element -- Local Blob evidence is reviewed directly, never sent through an image optimizer. */
"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cropStill } from '@hosty-sdk/app/feedback/client';
import type { FeedbackRect } from '@hosty-sdk/app/feedback';
export function useBlobUrl(blob?: Blob) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        const value = blob ? URL.createObjectURL(blob) : '';
        // Object URLs are external resources acquired and revoked with the image lifetime.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUrl(value);
        return () => { if (value) URL.revokeObjectURL(value); };
    }, [blob]);
    return url;
}
export function ImagePreview({ blob }: {
    blob: Blob;
}) { const url = useBlobUrl(blob); return url ? <img src={url} alt="Included screenshot"/> : null; }
export function CropPreview({ blob, onCancel, onAccept }: {
    blob: Blob;
    onCancel: () => void;
    onAccept: (blob: Blob) => Promise<void>;
}) {
    const url = useBlobUrl(blob);
    const [crop, setCrop] = useState<FeedbackRect | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const node = dialog.current;
        node?.showModal();
        return () => { node?.close(); };
    }, []);
    const start = useRef<{
        x: number;
        y: number;
    } | null>(null);
    const point = (event: ReactPointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (event.clientX - bounds.x) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.y) / bounds.height)) };
    };
    return <dialog ref={dialog} className="hf-crop" aria-label="Review screenshot" onCancel={event => { event.preventDefault(); if (!busy)
        onCancel(); }}>
    <h2>Review screenshot</h2><p>Check the selected source. Drag to crop, or adjust the percentages below. Only the approved image is included.</p>
    <div className="hf-crop-image" onPointerDown={event => { start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
            if (!start.current)
                return;
            const p = point(event);
            setCrop({ x: Math.min(p.x, start.current.x), y: Math.min(p.y, start.current.y),
                width: Math.abs(p.x - start.current.x), height: Math.abs(p.y - start.current.y) });
        }} onPointerUp={() => { start.current = null; }}>
      {url && <img src={url} alt="Captured screen for review" draggable={false}/>}
      {crop && <div className="hf-crop-selection" style={{ left: crop.x * 100 + "%", top: crop.y * 100 + "%", width: crop.width * 100 + "%", height: crop.height * 100 + "%" }}/>}
    </div>
    <div className="hf-actions">{(["x", "y", "width", "height"] as const).map(field => <label key={field}>{field === "x" ? "Left %" : field === "y" ? "Top %" : field === "width" ? "Width %" : "Height %"}
      <input type="number" min={0} max={100} value={Math.round((crop?.[field] ?? (field === "width" || field === "height" ? 1 : 0)) * 100)} onChange={event => setCrop({ ...(crop ?? { x: 0, y: 0, width: 1, height: 1 }), [field]: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })}/></label>)}</div>
    {error && <p role="alert">{error}</p>}<footer><button onClick={onCancel} disabled={busy}>Cancel</button><button onClick={() => setCrop(null)}>Use full image</button>
      <button className="hf-primary" disabled={busy || !!crop && (!crop.width || !crop.height)} onClick={() => { setBusy(true); void cropStill(blob, crop).then(onAccept).catch(e => setError(e instanceof Error ? e.message : "Could not crop screenshot.")).finally(() => setBusy(false)); }}>Include screenshot</button></footer>
  </dialog>;
}
