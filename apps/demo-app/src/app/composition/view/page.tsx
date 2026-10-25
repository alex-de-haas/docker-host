import { Suspense } from "react";
import { DemoLoading } from "@/components/DemoFeedback";
import { CompositionView } from "@/components/CompositionFixture";
export default function Page() { return <Suspense fallback={<DemoLoading label="Loading app view…" />}><CompositionView /></Suspense>; }
