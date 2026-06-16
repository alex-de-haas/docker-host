import type {
  AppHealthResponse,
  AppPageLink,
  CoreApp,
  CoreEndpoint,
  CoreInstallRuntimeProfile,
  DetailView,
  RuntimeServiceRow,
  SessionResponse,
} from "./types";
import { normalizeAppPath } from "./shell-routes";
import { buildPublicOriginSettingKey } from "./settings";

export function isAppAutostartEnabled(app: CoreApp) {
  return app.autostart ?? true;
}

export function formatUpdateChange(change: string): string {
  if (change === "manifest") {
    return "Manifest content changed";
  }

  if (change.startsWith("version:")) {
    return `Version changed from ${formatArrowValue(change.slice("version:".length))}`;
  }

  if (change.startsWith("runtime:")) {
    return `Runtime changed from ${formatArrowValue(change.slice("runtime:".length))}`;
  }

  if (change.startsWith("service:")) {
    return formatServiceChange(splitToken(change.slice("service:".length), 2));
  }

  if (change.startsWith("image:")) {
    const [service, diff] = splitToken(change.slice("image:".length), 1);
    return `Service ${service} image changed from ${formatArrowValue(diff)}`;
  }

  if (change.startsWith("command:")) {
    const [service] = splitToken(change.slice("command:".length), 1);
    return `Service ${service} command changed`;
  }

  if (change.startsWith("workingDirectory:")) {
    const [service, diff] = splitToken(change.slice("workingDirectory:".length), 1);
    return `Service ${service} working directory changed from ${formatArrowValue(diff)}`;
  }

  if (change.startsWith("port:")) {
    return formatResourceChange("Port", change.slice("port:".length));
  }

  if (change.startsWith("environment:")) {
    return formatResourceChange("Environment variable", change.slice("environment:".length));
  }

  if (change.startsWith("setting:")) {
    return formatSettingChange(change.slice("setting:".length));
  }

  if (change.startsWith("dependency:")) {
    return formatResourceChange("Dependency", change.slice("dependency:".length));
  }

  if (change.startsWith("endpoint:")) {
    return formatResourceChange("Endpoint", change.slice("endpoint:".length));
  }

  if (change.startsWith("data:")) {
    return formatDataChange(change.slice("data:".length));
  }

  if (change.startsWith("capability:")) {
    return formatResourceChange("Capability", change.slice("capability:".length));
  }

  return change;
}

function formatServiceChange(parts: string[]): string {
  const [service, action, detail] = parts;
  if (action === "added") {
    return `Service ${service} added (${detail})`;
  }

  if (action === "removed") {
    return `Service ${service} removed (${detail})`;
  }

  if (action === "runtimeType") {
    return `Service ${service} runtime type changed from ${formatArrowValue(detail || "")}`;
  }

  return `Service ${service} changed`;
}

function formatSettingChange(payload: string): string {
  const [setting, action, detail] = splitToken(payload, 2);
  if (action === "type") {
    return `Setting ${setting} type changed from ${formatArrowValue(detail || "")}`;
  }

  if (action === "secret") {
    return `Setting ${setting} secret flag changed from ${formatArrowValue(detail || "")}`;
  }

  return formatResourceChange("Setting", payload);
}

function formatDataChange(payload: string): string {
  const [action, detail] = splitToken(payload, 1);
  if (action === "added") {
    return `Data directory added at ${detail}`;
  }

  if (action === "removed") {
    return `Data directory removed from ${detail}`;
  }

  if (action === "target") {
    return `Data directory target changed from ${formatArrowValue(detail || "")}`;
  }

  return "Data directory changed";
}

function formatResourceChange(label: string, payload: string): string {
  const [name, detail] = splitToken(payload, 1);
  if (detail.startsWith("added:")) {
    return `${label} ${name} added (${detail.slice("added:".length)})`;
  }

  if (detail.startsWith("removed:")) {
    return `${label} ${name} removed (${detail.slice("removed:".length)})`;
  }

  if (detail === "added") {
    return `${label} ${name} added`;
  }

  if (detail === "removed") {
    return `${label} ${name} removed`;
  }

  if (detail === "changed") {
    return `${label} ${name} changed`;
  }

  if (detail.includes("->")) {
    return `${label} ${name} changed from ${formatArrowValue(detail)}`;
  }

  const [attribute, value] = splitToken(detail, 1);
  if (value) {
    return `${label} ${name} ${attribute} changed from ${formatArrowValue(value)}`;
  }

  return `${label} ${name} changed`;
}

function formatArrowValue(value: string): string {
  const separator = value.indexOf("->");
  if (separator === -1) {
    return value || "unknown";
  }

  return `${value.slice(0, separator)} to ${value.slice(separator + 2)}`;
}

function splitToken(value: string, fixedParts: number): string[] {
  const parts: string[] = [];
  let rest = value;
  for (let index = 0; index < fixedParts; index++) {
    const separator = rest.indexOf(":");
    if (separator === -1) {
      parts.push(rest);
      rest = "";
      break;
    }

    parts.push(rest.slice(0, separator));
    rest = rest.slice(separator + 1);
  }

  parts.push(rest);
  return parts;
}

export function getAppPageLinks(app: CoreApp): AppPageLink[] {
  const navigation = app.navigation || [];
  if (navigation.length > 0) {
    return navigation
      .map((item) => {
        const redirectUri = item.embeddedUrl || buildRedirectUriFromAppPath(app, item.path);
        return redirectUri ? { label: item.label, path: item.path, redirectUri } : null;
      })
      .filter((item): item is AppPageLink => item !== null);
  }

  const home = app.embeddedUrl || getOpenEndpoint(app)?.url;
  return home ? [{ label: "Home", path: "/", redirectUri: home }] : [];
}

export function findAppPageLink(app: CoreApp, path: string) {
  const targetPath = normalizeAppPath(path);
  const pages = getAppPageLinks(app);
  const exact = pages.find((page) => normalizeAppPath(page.path) === targetPath);
  if (exact) {
    return { ...exact, path: targetPath };
  }

  const redirectUri = buildRedirectUriFromAppPath(app, targetPath);
  return redirectUri ? { label: targetPath, path: targetPath, redirectUri } : null;
}

export function buildRedirectUriFromAppPath(app: CoreApp, path: string) {
  const base = app.embeddedUrl || getOpenEndpoint(app)?.url;
  if (!base) {
    return null;
  }

  try {
    const url = new URL(base);
    const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const appPath = path.startsWith("/") ? path : `/${path}`;
    url.pathname = `${basePath}${appPath}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return base;
  }
}

export function getOpenEndpoint(app: CoreApp) {
  return app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
}

export function getConfiguredPublicOrigin(app: CoreApp, endpointKey: string) {
  const settingKey = buildPublicOriginSettingKey(endpointKey);
  const value = app.settings?.find((setting) => setting.key === settingKey)?.value?.trim();
  return value && value.length > 0 ? value : null;
}

export function getEndpointPublicOrigin(app: CoreApp, endpoint: CoreEndpoint) {
  const value = endpoint.publicOrigin?.trim() || getConfiguredPublicOrigin(app, endpoint.key);
  return value && value.length > 0 ? value : null;
}

export function buildRuntimeServiceRows(app: CoreApp, health: AppHealthResponse | null | undefined): RuntimeServiceRow[] {
  const services = new Map<string, RuntimeServiceRow>();
  const ensureService = (service: string) => {
    const existing = services.get(service);
    if (existing) {
      return existing;
    }

    const created: RuntimeServiceRow = {
      service,
      status: health?.status || app.runtimeState || app.operationStatus,
      message: null,
      endpoints: [],
    };
    services.set(service, created);
    return created;
  };

  for (const service of health?.services || []) {
    const row = ensureService(service.service || "default");
    row.status = service.status || row.status;
    row.message = service.message || null;
  }

  const healthServices = health?.services || [];
  const fallbackEndpointService = healthServices.length === 1 ? healthServices[0].service : "endpoints";
  for (const endpoint of app.endpoints || []) {
    const service = getEndpointService(endpoint, fallbackEndpointService);
    ensureService(service).endpoints.push(endpoint);
  }

  return Array.from(services.values())
    .map((service) => ({
      ...service,
      endpoints: [...service.endpoints].sort((left, right) => left.key.localeCompare(right.key)),
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

export function getEndpointService(endpoint: CoreEndpoint, fallback = "endpoints") {
  const service = endpoint.service?.trim();
  if (service) {
    return service;
  }

  const separatorIndex = endpoint.key.indexOf(".");
  return separatorIndex > 0 ? endpoint.key.slice(0, separatorIndex) : fallback;
}

export function getHealthSummary(total: number, running: number, attention: number) {
  if (attention > 0) {
    return { label: `${attention} need attention`, className: "bg-amber-500/10 text-amber-700" };
  }
  if (total === 0) {
    return { label: "No apps", className: "bg-muted text-muted-foreground" };
  }
  if (running === total) {
    return { label: "Healthy", className: "bg-emerald-500/10 text-emerald-700" };
  }
  return { label: `${running}/${total} running`, className: "bg-sky-500/10 text-sky-700" };
}

export function getRuntimeCoverage(running: number, total: number) {
  if (total === 0) {
    return 0;
  }
  return Math.round((running / total) * 100);
}

export function formatRuntimeProfileLabel(profile: CoreInstallRuntimeProfile) {
  return `${profile.key}${profile.default ? " (default)" : ""} - ${profile.type}`;
}

export function pluralize(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}

export function getAccountInitials(user: NonNullable<SessionResponse["user"]>) {
  const source = user.displayName || user.email || user.id;
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

export function detailTitle(view: DetailView) {
  switch (view) {
    case "logs":
      return "Logs";
    case "backups":
      return "Backups";
    case "configure":
      return "Configure";
    case "mounts":
      return "External storage";
    case "update":
      return "Update";
    case "remove":
      return "Remove";
  }
}

export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
