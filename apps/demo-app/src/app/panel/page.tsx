import { DemoPanel } from "@/components/DemoPanel";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export default function Page() {
  return <DemoPanel config={getDemoConfig()} />;
}
