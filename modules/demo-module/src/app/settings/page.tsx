import { Route } from "lucide-react";
import {
  DemoNavigation,
  DemoPageHeader,
  DemoShell,
  DetailList,
  JsonButton,
  MetricCard,
  SectionCard,
  StateBadge,
  StorageGrid,
} from "@/components/DemoModuleUi";
import { getDemoConfig, inspectStorage } from "@/lib/demo-config";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const config = getDemoConfig();
  const storage = await inspectStorage();

  return (
    <DemoShell>
      <DemoPageHeader
        eyebrow={config.moduleId}
        title="Settings"
        description="Runtime configuration, Host integration, and storage mounts."
        actions={<JsonButton href="/api/config" />}
      />
      <DemoNavigation active="settings" />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.35fr)_minmax(0,0.65fr)]">
        <MetricCard
          icon={Route}
          label="Channel"
          value={config.releaseChannel}
          description="Current module release channel."
        />

        <SectionCard title="Runtime config">
          <DetailList
            items={[
              { label: "Public URL", value: config.publicUrl },
              { label: "Greeting", value: config.greeting },
              { label: "Refresh", value: `${config.refreshSeconds}s` },
              { label: "Auth preview", value: config.authPreview ? "Enabled" : "Disabled" },
            ]}
          />
        </SectionCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Host integration">
        <SectionCard
          title="Host integration"
          action={
            <StateBadge tone={config.host.moduleServiceTokenConfigured ? "success" : "danger"}>
              Service token {config.host.moduleServiceTokenConfigured ? "configured" : "missing"}
            </StateBadge>
          }
        >
          <DetailList
            items={[
              { label: "Internal origin", value: config.host.internalOrigin },
              { label: "Identity audience", value: config.host.moduleId },
            ]}
          />
        </SectionCard>

        <SectionCard title="Storage paths" action={<JsonButton href="/api/health" />}>
          <DetailList
            items={[
              { label: "Data", value: config.paths.data },
              { label: "Logs", value: config.paths.logs },
              { label: "External sources", value: config.paths.externalSourcesRoot },
            ]}
          />
        </SectionCard>
      </section>

      <section className="flex flex-col gap-4" aria-label="Storage settings">
        <div className="min-w-0 space-y-1">
          <h2 className="text-xl font-semibold leading-7">Storage probes</h2>
          <p className="text-sm text-muted-foreground">
            Current mount availability and visible entries.
          </p>
        </div>
        <StorageGrid storage={storage} />
      </section>
    </DemoShell>
  );
}
