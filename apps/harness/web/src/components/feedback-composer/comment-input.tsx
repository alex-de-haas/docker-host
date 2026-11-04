"use client";

import { useId, useMemo } from "react";
import { Camera, Check, Loader2 } from "lucide-react";
import { ChatAttachment } from "@/components/chat-attachment";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { FeedbackSpeech, type FeedbackSpeechController } from "./feedback-speech";

export function FeedbackCommentInput({ label, ariaLabel = label, target, value, maxLength, disabled,
  onChange, onDictation, speech, screenshot, onDone }: {
  label: string; ariaLabel?: string; target: string; value: string; maxLength: number; disabled: boolean;
  onChange: (value: string) => void; onDictation: (text: string) => void; speech: FeedbackSpeechController;
  screenshot?: { image?: Blob; capturing: boolean; available: boolean; capture: () => void; remove: () => void };
  onDone?: () => void;
}) {
  const id = useId();
  const blob = screenshot?.image;
  const image = useMemo(() => blob ? new File([blob], "screenshot.png", { type: blob.type }) : undefined, [blob]);
  const actionsDisabled = disabled || speech.phase !== "idle";
  const captureLabel = screenshot?.capturing ? "Capturing…" : image ? "Retake screenshot" : "Add screenshot";
  return <Field className="gap-2">
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <InputGroup aria-label={`${ariaLabel} and attachments`}>
      <InputGroupTextarea id={id} aria-label={ariaLabel} placeholder="Write your comment…" rows={2}
        className="max-h-48 min-h-20" maxLength={maxLength} disabled={disabled} value={value}
        onChange={event => onChange(event.target.value)} />
      <InputGroupAddon align="block-end" className="flex-col items-stretch gap-2">
        {image && <ChatAttachment name={image.name} size={image.size} file={image} description="Included in feedback"
          disabled={actionsDisabled} onRemove={screenshot?.remove} />}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {screenshot && <Button type="button" variant="ghost" size="icon-sm" aria-label={captureLabel} title={captureLabel}
              disabled={actionsDisabled || !screenshot.available} onClick={screenshot.capture}>
              {screenshot.capturing ? <Loader2 className="motion-safe:animate-spin" /> : <Camera />}
            </Button>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <FeedbackSpeech speech={speech} target={target} disabled={disabled} onText={onDictation} />
            {onDone && <Button type="button" size="sm" aria-label="Save comment" title="Save comment locally" disabled={actionsDisabled} onClick={onDone}><Check />Save comment</Button>}
          </div>
        </div>
      </InputGroupAddon>
    </InputGroup>
    {speech.target === target && speech.error && <div role="status" className="text-xs text-destructive">{speech.error}</div>}
  </Field>;
}
