"use client";
import { createInstallationClient, type InstallationRequest, type InstallationSource } from "@hosty-sdk/app/install";
export type WorkspaceAccessReview = InstallationSource & { workspaceManifest: Record<string, unknown> };
export type RetainedAccessReview = Pick<InstallationRequest, "id" | "expiresAt">;

/** Retain Core's review identity before submit; reload and uncertain responses never create a second request. */
export async function approveWorkspaceAccess(review: WorkspaceAccessReview, submitted: (request: InstallationRequest) => void,
  options: { retained?: RetainedAccessReview; remember?: (request: RetainedAccessReview | null) => void; cancelled?: () => boolean } = {},
): Promise<InstallationRequest> {
  const client = createInstallationClient({ baseUrl: "/api/workspace-access-reviews" });
  const checkCancelled = () => { if (options.cancelled?.()) throw new DOMException("Access confirmation closed.", "AbortError"); };
  checkCancelled();
  const candidate: WorkspaceAccessReview = { workspaceManifest: review.workspaceManifest };
  const prepared = options.retained ?? await client.prepare(candidate);
  options.remember?.({ id: prepared.id, expiresAt: prepared.expiresAt });
  const deadline = Date.parse(prepared.expiresAt);
  const check = () => {
    checkCancelled();
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Core access confirmation expired. Try again to review the current workspace.");
  };
  const readStatus = async (): Promise<InstallationRequest> => {
    for (;;) {
      check();
      try { const request = await client.status(prepared.id); check(); return request; }
      catch (error) {
        check();
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : null;
        if (status !== null && status >= 400 && status < 500) {
          if ([400, 404, 409, 410].includes(status)) options.remember?.(null);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  };
  check();
  let request = options.retained ? await readStatus() : prepared as InstallationRequest;
  if (!options.retained && request.status !== "draft") throw new Error("Core returned an unexpected access review state.");
  if (request.status === "draft") {
    try { request = await client.submit(prepared.id, {}, false); }
    catch (error) {
      check();
      if (error && typeof error === "object" && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500) throw error;
      request = await readStatus();
      if (request.status === "draft") throw error;
    }
  }
  check(); submitted(request);
  while (["pending", "executing"].includes(request.status)) {
    check(); await new Promise(resolve => setTimeout(resolve, 1000)); check();
    request = await readStatus();
  }
  if (["failed", "denied"].includes(request.status)) options.remember?.(null);
  if (request.status === "failed") throw new Error(request.error || "Core could not approve this workspace access.");
  if (!["succeeded", "denied"].includes(request.status)) throw new Error("Core returned an unexpected access review state.");
  return request;
}
