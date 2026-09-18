const baseSandbox = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** Only persisted Core grants opt an app into unsandboxed confirmation windows. */
export function appFrameSandbox(grantedCorePermissions?: readonly string[] | null): string {
  const canRequestApproval = grantedCorePermissions?.some(
    (permission) => permission === "apps.install" || permission === "apps.update",
  );
  return canRequestApproval ? `${baseSandbox} allow-popups-to-escape-sandbox` : baseSandbox;
}
