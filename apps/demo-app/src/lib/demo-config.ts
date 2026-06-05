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
    appId: string;
    appServiceTokenConfigured: boolean;
  };
  paths: {
    data: string;
    logs: string;
    externalSourcesRoot: string;
  };
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
const defaultAppVersion = "0.2.1";

export function getDemoConfig(): DemoConfig {
  const appId = process.env.HOSTY_APP_ID || defaultAppId;
  const coreOrigin = process.env.HOSTY_CORE_ORIGIN || process.env.HOST_CORE_PUBLIC_ORIGIN || "http://127.0.0.1:3001";
  const publicPort = process.env.HOSTY_PORT_HTTP || process.env.PORT;

  return {
    appId,
    appVersion: process.env.HOSTY_APP_VERSION || process.env.APP_VERSION || defaultAppVersion,
    greeting: process.env.DEMO_GREETING || "Hello from Hosty",
    releaseChannel: process.env.DEMO_RELEASE_CHANNEL || "local",
    refreshSeconds: readNumber(process.env.DEMO_REFRESH_SECONDS, 30),
    authPreview: readBoolean(process.env.DEMO_AUTH_PREVIEW, false),
    publicUrl: process.env.DEMO_PUBLIC_URL || (publicPort ? `http://localhost:${publicPort}` : "http://localhost:3100"),
    host: {
      coreOrigin,
      appId,
      appServiceTokenConfigured: Boolean(process.env.HOSTY_APP_SERVICE_TOKEN),
    },
    paths: {
      data: process.env.DEMO_DATA_DIR || defaultRuntimePath("data"),
      logs: process.env.DEMO_LOG_DIR || defaultRuntimePath("logs"),
      externalSourcesRoot: process.env.DEMO_EXTERNAL_SOURCES_ROOT || "/mnt/sources",
    },
  };
}

export async function inspectStorage(options: { writeProbe?: boolean } = {}) {
  const config = getDemoConfig();

  return Promise.all([
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
    inspectDirectory({
      key: "external-sources",
      label: "External sources",
      directoryPath: config.paths.externalSourcesRoot,
      writable: false,
      writeProbe: false,
    }),
  ]);
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
