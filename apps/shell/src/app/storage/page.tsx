import { ShellSettingsRoute } from "../shell/shell-route-pages";

export const dynamic = "force-dynamic";

// The route parser selects Host > Storage while the persistent Shell layout canonicalizes the URL.
export default function LegacyStoragePage() {
  return <ShellSettingsRoute />;
}
