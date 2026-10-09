import { Suspense } from "react";
import { WorkspacesSession } from "@/components/workspaces-session";
export default function Page() { return <Suspense fallback={<main className="session-state">Loading Workspaces…</main>}><WorkspacesSession /></Suspense>; }
