import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const appStartedAt = new Date().toISOString();

export interface DemoConfig {
  appId: string;
  appVersion: string;
  greeting: string;
  releaseChannel: string;
  refreshSeconds: number;
  authPreview: boolean;
  publicUrl: string;
  host: {
    coreOrigin: string;
    corePublicOrigin: string;
    appId: string;
    appServiceTokenConfigured: boolean;
  };
  paths: {
    data: string;
    logs: string;
  };
  mounts: DemoMount[];
}

export interface DemoMount {
  // Slot key (lower-cased from the HOSTY_MOUNT_{KEY} env name), the operator-chosen per-bind
  // label, and one host/container path.
  key: string;
  envName: string;
  label: string;
  path: string;
}

export interface StorageInspection {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  writable: boolean;
  entries: string[];
  error: string | null;
}

const defaultAppId = "com.haas.demo-app";
// Keep in step with manifest.json + package.json (enforced by scripts/check-versions.mjs).
const defaultAppVersion = "0.7.1";

export function getDemoConfig(): DemoConfig {
  const appId = process.env.HOSTY_APP_ID || defaultAppId;
  const coreOrigin = process.env.HOSTY_CORE_ORIGIN || "http://localhost:3001";
  // Browser-reachable Core origin for client redirects (session recovery); falls back to the
  // server-reachable origin only when the public one is not injected.
  const corePublicOrigin = process.env.HOSTY_CORE_PUBLIC_ORIGIN || coreOrigin;
  const publicPort = process.env.HOSTY_PORT_HTTP || process.env.PORT;

  return {
    appId,
    appVersion: process.env.HOSTY_APP_VERSION || process.env.APP_VERSION || defaultAppVersion,
    greeting: process.env.DEMO_GREETING || "Hello from Hosty",
    releaseChannel: process.env.DEMO_RELEASE_CHANNEL || "local",
    refreshSeconds: readNumber(process.env.DEMO_REFRESH_SECONDS, 30),
    authPreview: readBoolean(process.env.DEMO_AUTH_PREVIEW, false),
    publicUrl: process.env.HOSTY_PUBLIC_ORIGIN_HTTP || (publicPort ? `http://localhost:${publicPort}` : "http://localhost:3100"),
    host: {
      coreOrigin,
      corePublicOrigin,
      appId,
      appServiceTokenConfigured: Boolean(process.env.HOSTY_APP_SERVICE_TOKEN),
    },
    paths: {
      data: process.env.DEMO_DATA_DIR || defaultRuntimePath("data"),
      logs: process.env.DEMO_LOG_DIR || defaultRuntimePath("logs"),
    },
    mounts: discoverHostyMounts(),
  };
}

// Discovers the external mounts Hosty injected as HOSTY_MOUNT_{KEY}=label1=path1,label2=path2.
// Under docker the paths are container paths (each a bind mount); under localCommand they are the
// operator host paths read directly. Each comma-separated entry is `label=path`; a host path may
// contain '=', so split on the FIRST '=' only (labels never contain '='). The demo declares a
// `catalogRoots` slot, so a configured slot surfaces as HOSTY_MOUNT_CATALOGROOTS — but discovery
// is generic over any declared slot.
function discoverHostyMounts(): DemoMount[] {
  const prefix = "HOSTY_MOUNT_";
  const mounts: DemoMount[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix) || !value) {
      continue;
    }

    const key = name.slice(prefix.length).toLowerCase();
    for (const entry of value.split(",").map(part => part.trim()).filter(Boolean)) {
      const separator = entry.indexOf("=");
      const label = separator >= 0 ? entry.slice(0, separator) : "";
      const mountPath = separator >= 0 ? entry.slice(separator + 1) : entry;
      mounts.push({ key, envName: name, label, path: mountPath });
    }
  }

  return mounts.sort((a, b) => a.path.localeCompare(b.path));
}

export async function inspectStorage(options: { writeProbe?: boolean } = {}) {
  const config = getDemoConfig();

  const managed = await Promise.all([
    inspectDirectory({
      key: "data",
      label: "Data",
      directoryPath: config.paths.data,
      writable: true,
      writeProbe: options.writeProbe,
    }),
    inspectDirectory({
      key: "logs",
      label: "Logs",
      directoryPath: config.paths.logs,
      writable: true,
      writeProbe: options.writeProbe,
    }),
  ]);

  // External mounts are operator-owned, so they are inspected read-only (never write-probed) to
  // avoid littering the operator's folders. A "mounted" badge plus the entry listing is enough to
  // confirm the bind reached the container.
  const mounts = await Promise.all(
    config.mounts.map((mount, index) =>
      inspectDirectory({
        key: `mount-${mount.key}-${index}`,
        label: mount.label ? `Mount: ${mount.key}/${mount.label}` : `Mount: ${mount.key}`,
        directoryPath: mount.path,
        writable: false,
        writeProbe: false,
      })
    )
  );

  return [...managed, ...mounts];
}

function defaultRuntimePath(name: string) {
  if (process.env.NODE_ENV === "production") {
    return path.join("/app", name);
  }

  return path.join(process.cwd(), ".demo", name);
}

function readNumber(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

async function inspectDirectory({
  key,
  label,
  directoryPath,
  writable,
  writeProbe,
}: {
  key: string;
  label: string;
  directoryPath: string;
  writable: boolean;
  writeProbe?: boolean;
}): Promise<StorageInspection> {
  try {
    if (writeProbe && writable) {
      await mkdir(directoryPath, { recursive: true });
      await writeFile(
        path.join(directoryPath, ".demo-app-health"),
        JSON.stringify({ checkedAt: new Date().toISOString() }, null, 2)
      );
    }

    await access(directoryPath);
    const info = await stat(directoryPath);
    if (!info.isDirectory()) {
      return {
        key,
        label,
        path: directoryPath,
        exists: true,
        writable: false,
        entries: [],
        error: "Path exists but is not a directory.",
      };
    }

    const entries = await readDirectoryEntries(directoryPath);

    return {
      key,
      label,
      path: directoryPath,
      exists: true,
      writable,
      entries,
      error: null,
    };
  } catch (error) {
    return {
      key,
      label,
      path: directoryPath,
      exists: false,
      writable: false,
      entries: [],
      error: error instanceof Error ? error.message : "Directory could not be inspected.",
    };
  }
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter(entry => !entry.name.startsWith("."))
      .slice(0, 8)
      .map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}
