"use client";

import { ObservabilityMetricsPage } from "@/components/pages/metrics-page";
import { withCoreSource } from "@/lib/core-source";
import { useApps } from "@/components/app-shell";

export default function MetricsPage() {
  return <ObservabilityMetricsPage apps={withCoreSource(useApps())} />;
}
