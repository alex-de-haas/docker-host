import { ShellClient } from "./shell-client";

function getCoreOrigin() {
  return (
    process.env.HOSTY_CORE_ORIGIN ||
    process.env.NEXT_PUBLIC_HOSTY_CORE_ORIGIN ||
    "http://127.0.0.1:3001"
  ).replace(/\/$/, "");
}

export function HostyShellPage({ initialView = "dashboard" }: { initialView?: "available-apps" | "dashboard" }) {
  return <ShellClient coreOrigin={getCoreOrigin()} shellAppId={process.env.HOSTY_APP_ID || "hosty.shell"} initialView={initialView} />;
}
