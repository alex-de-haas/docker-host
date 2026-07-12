"use client";

import { ObservabilityMetricsPage } from "@/components/pages/metrics-page";
import { useApps } from "@/components/app-shell";

export default function MetricsPage() {
  return <ObservabilityMetricsPage apps={useApps()} />;
}
