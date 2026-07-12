"use client";

import { ObservabilityStructuredLogsPage } from "@/components/pages/structured-logs-page";
import { useApps } from "@/components/app-shell";

export default function LogsPage() {
  return <ObservabilityStructuredLogsPage apps={useApps()} />;
}
