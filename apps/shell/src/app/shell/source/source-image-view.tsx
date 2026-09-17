"use client";

import { useState } from "react";
import type { SourceImageSide } from "./source-preview-data";
import { isSourceImageDataUrl } from "./source-preview-data";

function ImageSide({ side, label, path }: { side: SourceImageSide; label: string; path: string }) {
  const [failed, setFailed] = useState(false);
  const available = isSourceImageDataUrl(side.dataUrl);
  return <figure className="min-w-0 space-y-2">
    <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
    {available && !failed
      // Core already supplied bounded, authenticated bytes. Do not send source images to an optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={side.dataUrl!} alt={`${label}: ${path}`} decoding="async" className="h-auto max-w-full rounded bg-muted/30" onError={() => setFailed(true)} />
      : <p role={failed ? "status" : undefined} className="text-sm text-muted-foreground">{failed ? "This image could not be decoded. Open it locally to view it." : side.message ?? "Image preview unavailable."}</p>}
  </figure>;
}

export default function SourceImageView({ path, before, after }: { path: string; before: SourceImageSide | null; after: SourceImageSide | null }) {
  return <div className={`grid gap-4 p-3 ${before && after ? "sm:grid-cols-2" : "grid-cols-1"}`}>
    {before && <ImageSide side={before} label="Before · HEAD" path={path} />}
    {after && <ImageSide side={after} label="After · working tree" path={path} />}
    {!before && !after && <p className="text-sm text-muted-foreground">No image version is available. Refresh source changes.</p>}
  </div>;
}
