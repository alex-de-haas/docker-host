import { ShellClient } from "./shell-client";

function getCoreOrigin() {
  const configuredOrigin = (
    process.env.HOSTY_CORE_PUBLIC_ORIGIN ||
    process.env.NEXT_PUBLIC_HOSTY_CORE_PUBLIC_ORIGIN ||
    process.env.NEXT_PUBLIC_HOSTY_CORE_ORIGIN
  )?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/$/, "");
  }

  const corePort = (process.env.HOSTY_CORE_PORT || process.env.NEXT_PUBLIC_HOSTY_CORE_PORT || "3001").trim();
  return `http://localhost:${corePort}`;
}

export function HostyShellPage() {
  return <ShellClient coreOrigin={getCoreOrigin()} shellAppId={process.env.HOSTY_APP_ID || "hosty.shell"} />;
}
