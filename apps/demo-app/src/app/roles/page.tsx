import { DemoRoles } from "@/components/DemoRoles";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export default function Page() {
  return <DemoRoles config={getDemoConfig()} />;
}
