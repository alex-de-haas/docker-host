import { Suspense } from "react";
import { PlansSession } from "@/components/plans-session";
export default function Page() { return <Suspense fallback={<main className="session-state">Loading Plans…</main>}><PlansSession /></Suspense>; }
