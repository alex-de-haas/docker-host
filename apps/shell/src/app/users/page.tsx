import { ShellSettingsRoute } from "../shell/shell-route-pages";

export const dynamic = "force-dynamic";

// User Management became a Settings tab. The route file stays so the old URL resolves instead of
// 404ing before the client can canonicalize it to /settings?tab=users.
export default function UsersPage() {
  return <ShellSettingsRoute />;
}
