"use client";
import { createInstallationClient, type InstallationRequest, type InstallationSource } from "@hosty-sdk/app/install";
export type WorkspaceAccessReview = InstallationSource & { workspaceManifest: Record<string, unknown> };

/** Register and submit the exact review before opening Core; a plan alone has no approval URL. */
export async function approveWorkspaceAccess(review: WorkspaceAccessReview, submitted: (request: InstallationRequest) => void): Promise<InstallationRequest> {
  const client = createInstallationClient({ baseUrl: "/api/workspace-access-reviews" });
  const candidate: WorkspaceAccessReview = { workspaceManifest: review.workspaceManifest };
  const prepared = await client.prepare(candidate);
  if (prepared.status !== "draft") throw new Error("Core returned an unexpected access review state.");
  const deadline = Date.parse(prepared.expiresAt);
  const check = () => { if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Core access confirmation expired. Review the current workspace candidate again."); };
  check();
  const readStatus = async () => {
    for (;;) {
      check();
      try { return await client.status(prepared.id); }
      catch (error) {
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : null;
        if (status !== null && status >= 400 && status < 500) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  };
  let request: InstallationRequest;
  try { request = await client.submit(prepared.id, {}, false); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500) throw error;
    check(); request = await readStatus();
    if (request.status === "draft") throw error;
  }
  submitted(request);
  while (["pending", "executing"].includes(request.status)) {
    check(); await new Promise(resolve => setTimeout(resolve, 1000)); check();
    request = await readStatus();
  }
  if (request.status === "failed") throw new Error(request.error || "Core could not approve this workspace access.");
  if (!["succeeded", "denied"].includes(request.status)) throw new Error("Core returned an unexpected access review state.");
  return request;
}
