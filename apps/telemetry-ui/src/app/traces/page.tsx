"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ObservabilityTracesPage } from "@/components/pages/traces-page";
import { useApps } from "@/components/app-shell";

function View() {
  const params = useSearchParams();
  return <ObservabilityTracesPage key={params.toString()} apps={useApps()} initialTraceId={params.get("traceId") ?? ""} initialCaller={params.get("callerAppId") ?? ""} />;
}
export default function Page() { return <Suspense><View /></Suspense>; }
