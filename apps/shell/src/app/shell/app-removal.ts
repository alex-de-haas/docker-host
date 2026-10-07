import { InstallationFlow, type InstallationClient, type InstallationRequest, type InstallationSource } from "@hosty-sdk/app/install";

/** Prepare once, recover a lost submit by status, and never treat a pending request as removal. */
export async function requestCoreApproval(
  client: InstallationClient,
  source: InstallationSource,
  onSubmitted: (request: InstallationRequest) => void | (() => void),
  options: { retryInterruptedStatus?: boolean } = {},
): Promise<InstallationRequest> {
  const flow = new InstallationFlow(client);
  let dismissConfirmation: void | (() => void) = undefined;
  try {
    await flow.review(source);
    if (flow.snapshot().error) throw new Error(flow.snapshot().error!);
    const submitted = await flow.submit({}, false);
    if (!submitted) throw new Error(flow.snapshot().error ?? "Could not submit request for Core confirmation.");
    let request: InstallationRequest = submitted;
    dismissConfirmation = onSubmitted(request);
    const dismissIfDecided = () => {
      if (request.status !== "pending" && dismissConfirmation) {
        dismissConfirmation();
        dismissConfirmation = undefined;
      }
    };
    dismissIfDecided();
    while (request.status === "pending" || request.status === "executing") {
      if (Date.now() >= Date.parse(request.expiresAt))
        throw new Error("Core confirmation expired or is still running. Check Core before preparing another request.");
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        request = await client.status(request.id);
      } catch (error) {
        // A Shell self-update temporarily removes the proxy serving this status request.
        // Retry only reads, within the existing deadline; never repeat prepare or submit.
        const status = error instanceof Error && "status" in error ? Number(error.status) : null;
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
    flow.dispose();
  }
}

export function requestAppRemoval(
  client: InstallationClient, appId: string,
  options: NonNullable<InstallationSource["removalOptions"]>,
  onSubmitted: (request: InstallationRequest) => void | (() => void),
): Promise<InstallationRequest> {
  return requestCoreApproval(client, { removeAppId: appId, removalOptions: options }, onSubmitted);
}
