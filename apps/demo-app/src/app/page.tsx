import { DemoOverview } from "@/components/DemoOverview";
import { getDemoConfig, inspectStorage, appStartedAt } from "@/lib/demo-config";

export const dynamic = "force-dynamic";
export default async function Home() {
  return <DemoOverview config={getDemoConfig()} storage={await inspectStorage()} appStartedAt={appStartedAt} />;
}
