import { ShellWorkspaceRoute } from "../../shell/shell-route-pages";

export const dynamic = "force-dynamic";

// The admin-only system-app deep link collapsed into /workspace. The route file stays so an existing
// link resolves — and keeps its ?path= — instead of 404ing before the client canonicalizes it.
export default function SystemAppPage() {
  return <ShellWorkspaceRoute />;
}
