"use client";

import { ObservabilityTracesPage } from "@/components/pages/traces-page";
import { useApps } from "@/components/app-shell";

export default function TracesPage() {
  return <ObservabilityTracesPage apps={useApps()} />;
}
