import { headers } from "next/headers";
import {
  Activity,
  Clock3,
  Database,
  Fingerprint,
  HardDrive,
  Route,
} from "lucide-react";
import {
  DemoNavigation,
  DemoPageHeader,
  DemoShell,
  DetailList,
  JsonButton,
  MetricCard,
  PeopleList,
  SectionCard,
  StateBadge,
  StorageGrid,
  type StateTone,
} from "@/components/DemoAppUi";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Status,
  StatusIndicator,
  StatusLabel,
} from "@/components/ui/status";
import { getDemoConfig, inspectStorage, appStartedAt } from "@/lib/demo-config";
import { getDemoAuthSnapshot } from "@/lib/host-auth";
import { roleSourceLabel } from "@/lib/app-roles";
import type { AppDirectoryStatus, AppSessionStatus } from "@/lib/host-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = getDemoConfig();
  const storage = await inspectStorage();
  const auth = await getDemoAuthSnapshot(await headers());

  return (
    <DemoShell>
      <DemoPageHeader
        eyebrow={config.appId}
        title="Hosty Demo App"
        description="Runtime diagnostics for Hosty app lifecycle development."
        actions={
          <Status status="online">
            <StatusIndicator />
            <StatusLabel>Running</StatusLabel>
          </Status>
        }
      />
      <DemoNavigation active="overview" />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <Card className="justify-center">
          <CardHeader>
            <CardDescription>{config.greeting}</CardDescription>
            <CardTitle className="max-w-3xl text-2xl font-semibold leading-tight sm:text-3xl">
              App operations test surface
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              A compact runtime app that exposes runtime config, storage probes, assigned
              Host directory data, and health endpoints for Hosty development.
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <MetricCard
            icon={Activity}
            label="Version"
            value={config.appVersion}
          />
          <MetricCard
            icon={Route}
            label="Channel"
            value={config.releaseChannel}
          />
          <MetricCard
            icon={Clock3}
            label="Refresh"
            value={`${config.refreshSeconds}s`}
          />
          <MetricCard
            icon={HardDrive}
            label="Started"
            value={new Date(appStartedAt).toLocaleTimeString("en", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          />
          <MetricCard
            icon={Fingerprint}
            label="Session"
            value={formatAppSessionStatus(auth.appSession.status)}
          />
          <MetricCard
            icon={Database}
            label="Directory"
            value={formatDirectoryStatus(auth.directory.status)}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Runtime details">
        <SectionCard title="Runtime config" action={<JsonButton href="/api/config" />}>
          <DetailList
            items={[
              { label: "Public URL", value: config.publicUrl },
              { label: "Auth preview", value: config.authPreview ? "Enabled" : "Disabled" },
              { label: "App id", value: config.host.appId },
              { label: "Core origin", value: config.host.coreOrigin },
              { label: "Identity audience", value: config.host.appId },
              {
                label: "Service token",
                value: config.host.appServiceTokenConfigured ? "Configured" : "Missing",
              },
              { label: "Health endpoint", value: "/api/health" },
            ]}
          />
        </SectionCard>

        <SectionCard title="People" action={<JsonButton href="/api/people" />}>
          {auth.directory.users.length > 0 ? (
            <PeopleList users={auth.directory.users} />
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {auth.directory.error?.message || "No assigned Host users were returned."}
            </p>
          )}
        </SectionCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-3" aria-label="Host authorization">
        <SectionCard
          title="App session"
          action={<StateBadge tone={appSessionStateTone(auth.appSession.status)}>{formatAppSessionStatus(auth.appSession.status)}</StateBadge>}
        >
          <div className="flex flex-col gap-4">
            <DetailList
              items={[
                { label: "App", value: auth.appSession.appId },
                { label: "Core", value: auth.appSession.coreOrigin },
                { label: "User", value: auth.appSession.userId || "Unavailable" },
                { label: "Expires", value: auth.appSession.expiresAt || "Unavailable" },
              ]}
            />
            {auth.appSession.error ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {auth.appSession.error.message}
              </p>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Current Host user" action={<JsonButton href="/api/auth/identity" />}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StateBadge tone={appSessionStateTone(auth.appSession.status)}>
                {formatAppSessionStatus(auth.appSession.status)}
              </StateBadge>
              <span className="break-all text-xs text-muted-foreground">
                {auth.appSession.tokenSource || "no token"}
              </span>
            </div>
            {auth.appSession.userId ? (
              <DetailList
                items={[
                  { label: "Subject", value: auth.appSession.userId },
                  {
                    label: "User",
                    value:
                      auth.appSession.displayName ||
                      auth.appSession.email ||
                      "Unnamed Host user",
                  },
                  { label: "Host role", value: auth.appSession.hostRole || "Unknown" },
                  { label: "App", value: auth.appSession.appId },
                  { label: "Expires", value: auth.appSession.expiresAt || "Unknown" },
                ]}
              />
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {auth.appSession.error?.message || "No app identity token was received."}
              </p>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="App directory"
          action={
            <StateBadge tone={directoryStateTone(auth.directory.status)}>
              {formatDirectoryStatus(auth.directory.status)}
            </StateBadge>
          }
        >
          <div className="flex flex-col gap-4">
            <DetailList
              items={[
                { label: "Endpoint", value: auth.directory.endpoint || "Unavailable" },
                {
                  label: "Assigned users",
                  value: auth.directory.pagination?.total ?? auth.directory.users.length,
                },
              ]}
            />
            {auth.directory.users.length > 0 ? (
              <PeopleList users={auth.directory.users} />
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {auth.directory.error?.message || "No assigned Host users were returned."}
              </p>
            )}
          </div>
        </SectionCard>
      </section>

      <section
        className="grid gap-4 lg:grid-cols-2"
        aria-label="App-owned authorization"
      >
        <SectionCard
          title="App permissions"
          action={<StateBadge tone="success">{auth.appPermissions.roleLabel}</StateBadge>}
        >
          <DetailList
            items={[
              { label: "Principal", value: auth.appPermissions.principal },
              { label: "Role source", value: roleSourceLabel(auth.appPermissions.source) },
              {
                label: "Can manage roles",
                value: auth.appPermissions.canManageRoles ? "Yes" : "No",
              },
              { label: "Permissions", value: auth.appPermissions.permissions.join(", ") },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Gateway request"
          action={
            <StateBadge tone={auth.gateway.hostSessionCookieForwarded ? "danger" : "success"}>
              Host cookie {auth.gateway.hostSessionCookieForwarded ? "present" : "stripped"}
            </StateBadge>
          }
        >
          <DetailList
            items={[
              { label: "Host", value: auth.gateway.host || "Unknown" },
              { label: "Forwarded host", value: auth.gateway.forwardedHost || "Missing" },
              { label: "Forwarded proto", value: auth.gateway.forwardedProto || "Missing" },
              {
                label: "X-Docker-Host headers",
                value:
                  auth.gateway.dockerHostHeaders.length > 0
                    ? auth.gateway.dockerHostHeaders.join(", ")
                    : "None",
              },
            ]}
          />
        </SectionCard>
      </section>

      <section className="flex flex-col gap-4" aria-label="Storage">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="text-xl font-semibold leading-7">Storage probes</h2>
            <p className="text-sm text-muted-foreground">
              App-owned data, log, and external source mount checks.
            </p>
          </div>
          <JsonButton href="/api/health" />
        </div>
        <StorageGrid storage={storage} />
      </section>
    </DemoShell>
  );
}

function formatAppSessionStatus(status: AppSessionStatus) {
  switch (status) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    case "forbidden":
      return "Forbidden";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Error";
    case "not-present":
      return "Not present";
  }
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

function appSessionStateTone(status: AppSessionStatus): StateTone {
  if (status === "active") {
    return "success";
  }

  return status === "not-present" ? "warning" : "danger";
}

function directoryStateTone(status: AppDirectoryStatus): StateTone {
  if (status === "ok") {
    return "success";
  }

  return status === "not-configured" ? "warning" : "danger";
}
