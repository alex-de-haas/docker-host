import { headers } from "next/headers";
import { Users } from "lucide-react";
import {
  DemoNavigation,
  DemoPageHeader,
  DemoShell,
  JsonButton,
  MetricCard,
  PeopleList,
  SectionCard,
  StateBadge,
  type StateTone,
} from "@/components/DemoAppUi";
import { getDemoConfig } from "@/lib/demo-config";
import { getDemoAuthSnapshot, type AppDirectoryStatus } from "@/lib/host-auth";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const config = getDemoConfig();
  const { directory } = await getDemoAuthSnapshot(await headers());
  const userCount = directory.pagination?.total ?? directory.users.length;

  return (
    <DemoShell>
      <DemoPageHeader
        eyebrow={config.appId}
        title="People"
        description="Host users explicitly assigned to this app through Docker Host access management."
        actions={<JsonButton href="/api/people" />}
      />
      <DemoNavigation active="people" />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.35fr)_minmax(0,1fr)]">
        <MetricCard
          icon={Users}
          label="Records"
          value={userCount}
          description={`App directory is ${formatDirectoryStatus(directory.status).toLowerCase()}.`}
        />

        <SectionCard
          title="Assigned Host users"
          description="This list is loaded from the Host app directory using the app service token."
          action={
            <StateBadge tone={directoryStateTone(directory.status)}>
              {formatDirectoryStatus(directory.status)}
            </StateBadge>
          }
        >
          {directory.users.length > 0 ? (
            <PeopleList users={directory.users} />
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {directory.error?.message || "No assigned Host users were returned."}
            </p>
          )}
        </SectionCard>
      </section>
    </DemoShell>
  );
}

function formatDirectoryStatus(status: AppDirectoryStatus) {
  switch (status) {
    case "ok":
      return "Ready";
    case "forbidden":
      return "Forbidden";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Error";
    case "not-configured":
      return "Not configured";
  }
}

function directoryStateTone(status: AppDirectoryStatus): StateTone {
  if (status === "ok") {
    return "success";
  }

  return status === "not-configured" ? "warning" : "danger";
}
