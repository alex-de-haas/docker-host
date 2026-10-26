import { Suspense } from "react";
import { DocumentsSession } from "@/components/plans-session";
export default function Page() { return <Suspense fallback={<main className="session-state">Loading Documents…</main>}><DocumentsSession /></Suspense>; }
