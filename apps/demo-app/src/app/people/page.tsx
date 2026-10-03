import { DemoPeople } from "@/components/DemoPeople";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export default function Page() {
  return <DemoPeople config={getDemoConfig()} />;
}
