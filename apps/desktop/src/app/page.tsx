import { Suspense } from "react";
import { DesktopSession } from "@/components/desktop-session";
export const dynamic = "force-dynamic";
export default function Page() {
  return <Suspense fallback={<main className="boot-screen">Opening your desktop…</main>}>
    <DesktopSession appId={process.env.HOSTY_APP_ID || "hosty.desktop"} coreOrigin={process.env.HOSTY_CORE_PUBLIC_ORIGIN || ""} />
  </Suspense>;
}
