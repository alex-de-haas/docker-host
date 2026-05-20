import { Users } from "lucide-react";
import {
  DemoNavigation,
  DemoPageHeader,
  DemoShell,
  JsonButton,
  MetricCard,
  PeopleList,
  SectionCard,
} from "@/components/DemoModuleUi";
import { getDemoPeople } from "@/lib/demo-data";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";

export default function PeoplePage() {
  const config = getDemoConfig();
  const people = getDemoPeople();

  return (
    <DemoShell>
      <DemoPageHeader
        eyebrow={config.moduleId}
        title="People"
        description="Stable sample directory route for shell navigation and API checks."
        actions={<JsonButton href="/api/people" />}
      />
      <DemoNavigation active="people" />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.35fr)_minmax(0,1fr)]">
        <MetricCard
          icon={Users}
          label="Records"
          value={people.length}
          description="Loaded from module configuration or fallback data."
        />

        <SectionCard
          title="Directory sample"
          description="Sample records exposed by the demo people endpoint."
        >
          <PeopleList people={people} />
        </SectionCard>
      </section>
    </DemoShell>
  );
}
