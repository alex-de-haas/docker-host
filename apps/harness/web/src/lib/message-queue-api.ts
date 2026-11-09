"use client";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { AssistantApiError, type StoredAttachment } from "./assistant-api";

export type QueueDraft = { text: string; attachments: StoredAttachment[] };
export type QueueEntry = {
  id: string; text: string; attachments: (StoredAttachment & { id: string })[]; createdAt: string;
  state: "queued" | "editing" | "sending" | "failed" | "unknown"; error?: { code: string; message: string };
  edit?: { reservationId: string; viewId: string; generation: number; text: string; attachments: StoredAttachment[]; stashedDraft: QueueDraft };
  attempt?: { clientRequestId: string };
};
export type MessageQueue = { version: 1; revision: number; ownerId: string; installationId: string; entries: QueueEntry[];
  paused: boolean; reason?: string; waiting?: { code: string; message: string }; updatedAt: string };
export type QueueCommand =
  | { type: "enqueue"; entryId: string; text: string; attachments: string[]; promptSuggestions?: boolean; withoutAppDetails?: boolean }
  | { type: "reserve_edit"; entryId: string; viewId: string; stashedDraft: { text: string; attachments: string[] } }
  | { type: "save_edit" | "update_edit"; entryId: string; reservationId: string; viewId: string; text: string; attachments: string[] }
  | { type: "cancel_edit"; entryId: string; reservationId: string; viewId: string }
  | { type: "recover_edit"; entryId: string; viewId: string }
  | { type: "delete" | "retry"; entryId: string }
  | { type: "reorder"; entryIds: string[] }
  | { type: "pause" | "resume" };
export type QueueCommandInput = { requestId: string; expectedRevision: number; command: QueueCommand };
export type QueueCommandReply = { queue: MessageQueue; result: { revision: number; entryId?: string; reservationId?: string } };

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new AssistantApiError(body?.code, body?.message ?? `Queue request failed (${response.status}).`, response.status);
  }
  return response.json();
}
const path = (id: string) => `/api/sessions/${encodeURIComponent(id)}/message-queue`;
export async function getMessageQueue(id: string): Promise<MessageQueue> { return read(await appFetch(path(id))); }
export async function commandMessageQueue(id: string, input: QueueCommandInput): Promise<QueueCommandReply> {
  return read(await appFetch(`${path(id)}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
}
export async function uploadQueueAttachment(id: string, uploadId: string, name: string, bytes: Blob): Promise<StoredAttachment> {
  const reply = await read<{ attachment: StoredAttachment }>(await appFetch(`${path(id)}/uploads/${encodeURIComponent(uploadId)}?name=${encodeURIComponent(name)}`,
    { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes }));
  return reply.attachment;
}
