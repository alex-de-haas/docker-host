import type { InstallationClient, InstallationRequest, InstallationSource } from "@hosty-sdk/app/install";

export class CoreApprovalStatusUnknownError extends Error {
  constructor(readonly requestId: string, readonly expiresAt: string) {
    super("Core confirmation expired or its outcome is unknown. Check Core before preparing another request.");
  }
}
const statusCode = (error: unknown) => error instanceof Error && "status" in error ? Number(error.status) : null;
const wait = () => new Promise(resolve => setTimeout(resolve, 1000));
function checkDeadline(request: InstallationRequest) {
  const deadline = Date.parse(request.expiresAt);
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw new CoreApprovalStatusUnknownError(request.id, request.expiresAt);
}

/** Prepare once, recover a lost submit by status, and never treat a pending request as removal. */
export async function requestCoreApproval(
  client: InstallationClient,
  source: InstallationSource,
  onSubmitted: (request: InstallationRequest) => void | (() => void),
  options: { retryInterruptedStatus?: boolean } = {},
): Promise<InstallationRequest> {
  let dismissConfirmation: void | (() => void) = undefined;
  try {
    const prepared = await client.prepare(source);
    if (prepared.status !== "draft") throw new Error("Core returned an unexpected approval status.");
    checkDeadline(prepared);
    let request: InstallationRequest;
    try {
      request = await client.submit(prepared.id, {}, false);
    } catch (submitError) {
      // A definitive Core refusal cannot authorize this request. Transport/5xx failures are
      // uncertain: recover only by reading this identity, even when the first read also fails.
      const code = statusCode(submitError);
      if (code !== null && code >= 400 && code < 500) throw submitError;
      for (;;) {
        checkDeadline(prepared);
        let observed: InstallationRequest;
        try { observed = await client.status(prepared.id); }
        catch (readError) {
          const readCode = statusCode(readError);
          if (readCode !== null && readCode >= 400 && readCode < 500) throw readError;
          await wait();
          continue;
        }
        if (observed.status === "draft") throw submitError;
        request = observed;
        break;
      }
    }
    dismissConfirmation = onSubmitted(request);
    const dismissIfDecided = () => {
      if (request.status !== "pending" && dismissConfirmation) {
        dismissConfirmation();
        dismissConfirmation = undefined;
      }
    };
    dismissIfDecided();
    while (request.status === "pending" || request.status === "executing") {
      checkDeadline(request);
      await wait();
      checkDeadline(request);
      try {
        request = await client.status(request.id);
      } catch (error) {
        // A Shell self-update temporarily removes the proxy serving this status request.
        // Retry only reads, within the existing deadline; never repeat prepare or submit.
        const status = statusCode(error);
        if (!options.retryInterruptedStatus || !(error instanceof TypeError || (status !== null && status >= 500))) throw error;
      }
      dismissIfDecided();
    }
    if (request.status === "failed") throw new Error(request.error ?? "Operation failed.");
    if (request.status !== "succeeded" && request.status !== "denied")
      throw new Error("Core returned an unexpected approval status.");
    return request;
  } finally {
    dismissConfirmation?.();
  }
}

export function requestAppRemoval(
  client: InstallationClient, appId: string,
  options: NonNullable<InstallationSource["removalOptions"]>,
  onSubmitted: (request: InstallationRequest) => void | (() => void),
): Promise<InstallationRequest> {
  return requestCoreApproval(client, { removeAppId: appId, removalOptions: options }, onSubmitted);
}
