import { HostyShellPage } from "../shell-page";

export const dynamic = "force-dynamic";

export default function AppsPage() {
  return <HostyShellPage initialView="available-apps" />;
}
