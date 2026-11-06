import { Suspense } from "react";
import { DocumentsWorkbench } from "@/components/workbench";
export default function Page() { return <Suspense fallback={<main className="session-state">Loading Documents…</main>}><DocumentsWorkbench /></Suspense>; }
