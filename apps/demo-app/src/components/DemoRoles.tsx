"use client";
import { ShieldCheck, UsersRound } from "lucide-react";
import {
  DemoNavigation,
  DemoPageHeader,
  DemoShell,
  JsonButton,
  MetricCard,
  SectionCard,
  StateBadge,
} from "@/components/DemoAppUi";
import { AppRoleManager } from "@/components/AppRoleManager";
import type { DemoConfig } from "@/lib/demo-config";
import type { DemoRoleManagementSnapshot } from "@/lib/app-role-management";
import { DemoResource } from "./DemoSession";


export function DemoRoles({ config }: { config: DemoConfig }) {
  return <DemoResource<DemoRoleManagementSnapshot> path="/api/roles">{snapshot => <RolesContent config={config} snapshot={snapshot} />}</DemoResource>;
}

function RolesContent({ config, snapshot }: { config: DemoConfig; snapshot: DemoRoleManagementSnapshot }) {

  return (
    <DemoShell>
      <DemoPageHeader
        eyebrow={config.appId}
        title="App Roles"
        description="App-owned role assignments persisted in the demo app data directory."
        actions={<JsonButton href="/api/roles" />}
      />
      <DemoNavigation active="roles" />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.35fr)_minmax(0,1fr)]">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <MetricCard
            icon={UsersRound}
            label="Directory users"
            value={snapshot.users.length}
            description={`Directory status is ${snapshot.directory.status}.`}
          />
          <MetricCard
            icon={ShieldCheck}
            label="Stored roles"
            value={snapshot.assignments.length}
            description="Explicit app assignments in app-roles.json."
          />
        </div>

        <SectionCard
          title="Role Assignments"
          action={
            <StateBadge tone={snapshot.canManage ? "success" : "warning"}>
              {snapshot.canManage ? "Manage" : "Read only"}
            </StateBadge>
          }
        >
          <AppRoleManager initialSnapshot={snapshot} />
        </SectionCard>
      </section>
    </DemoShell>
  );
}
