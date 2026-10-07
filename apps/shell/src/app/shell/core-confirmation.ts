import { openInstallationConfirmation, showInstallationConfirmation, type InstallationRequest } from "@hosty-sdk/app/install";
import { toast } from "@/components/reui/operation-toast";

/** An open Core window is the prompt; only blocked popups need a fallback link. */
export function showCoreConfirmation(popup: Window | null, request: InstallationRequest): (() => void) | undefined {
  const blocked = !popup || popup.closed;
  showInstallationConfirmation(popup, request);
  if (!blocked || request.status !== "pending") return;

  const id = toast.info("Open Core confirmation", {
    description: "The confirmation window could not open. Open Hosty Core to review this request.",
    duration: 60_000,
    action: {
      label: "Open confirmation",
      onClick: () => {
        const retry = openInstallationConfirmation();
        if (!retry || retry.closed) return;
        showInstallationConfirmation(retry, request);
        toast.dismiss(id);
      },
    },
  });
  return () => toast.dismiss(id);
}
