import { Suspense } from "react";
import { CompositionView } from "@/components/CompositionFixture";
export default function Page() { return <Suspense fallback={<p>Loading app view…</p>}><CompositionView /></Suspense>; }
