"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { FileText, Loader2, X } from "lucide-react";
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent,
  AttachmentDescription, AttachmentMedia, AttachmentTitle,
} from "@/components/ui/attachment";

export function ChatAttachment({ name, size, file, state = "done", description, onRemove, disabled }: {
  name: string;
  size: number | null;
  file?: File;
  state?: ComponentProps<typeof Attachment>["state"];
  description?: string;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const image = file?.type.startsWith("image/") === true;
  return (
    <Attachment size="sm" state={state} className="w-full" aria-label={name}
      aria-busy={state === "uploading" || state === "processing"}>
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {image && file ? <LocalImagePreview file={file} /> : state === "uploading" ? <Loader2 className="animate-spin" aria-hidden /> : <FileText aria-hidden />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={name}>{name}</AttachmentTitle>
        <AttachmentDescription title={description}>
          {[size === null ? null : formatAttachmentSize(size), description].filter(Boolean).join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {onRemove && <AttachmentActions>
        <AttachmentAction type="button" size="icon-sm" disabled={disabled}
          aria-label={`Remove ${name}`} onClick={onRemove}><X /></AttachmentAction>
      </AttachmentActions>}
    </Attachment>
  );
}

function LocalImagePreview({ file }: { file: File }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const url = URL.createObjectURL(file);
    image.hidden = false;
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  // Only operator-selected local blobs are previewed; transcript URLs never fetch remote images.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imageRef} alt={`Preview of ${file.name}`} onError={event => {
    URL.revokeObjectURL(event.currentTarget.src);
    event.currentTarget.hidden = true;
  }} />;
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
