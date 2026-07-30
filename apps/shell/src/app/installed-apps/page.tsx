import { ShellDashboardRoute } from "../shell/shell-route-pages";

export const dynamic = "force-dynamic";

// Installed Apps merged into Dashboard. The route file stays so the old URL resolves instead of
// 404ing before the client can canonicalize it to /dashboard.
export default function InstalledAppsPage() {
  return <ShellDashboardRoute />;
}
